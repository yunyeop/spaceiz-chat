require('dotenv').config();

const fs = require('fs');
const express = require('express');
const socket = require('socket.io');
const http = require('http');
const https = require('https');
const pid = require('process').pid;
const crypto = require('crypto');
const app = express();
const cors = require('cors');
const redis_adapter = require('socket.io-redis');
const redis = require('redis');

const server = http.createServer(app);

const ID_SALT = process.env.ID_SALT;
const NICK_SALT = process.env.NICK_SALT;
const SECRET = process.env.SECRET;

const io = socket(server);

io.adapter(redis_adapter({ host: 'localhost', port:6379 }));

app.use(cors());

/**
 * LEVEL
 * 2 = 일반사용자
 * 4 = 중계자
 * 10 = 최고관리자
 */
const COMMON_USER_LEVEL = 2;
const OWNER_USER_LEVEL = 4;
const ADMIN_USER_LEVEL = 10;

// 사용자 수
let connectedCnt = 0;
// 채팅방 얼녹 여부
let isFreeze = false;
// 사용자 접속 목록
let connectionList = {};
// 관리자 접속 목록
let adminList = {};
// 중계자 접속 목록
let owner = [];
// 관리자 콘솔 접속 목록
let consoleList = {};
// 차단 || 채금된 사용자 목록
let trashList = {};
// 공지글 목록
let notice = {};
// 투표정보
let vote = {};
// 투표중복 여부
let isVote = {}
// 비속어 필터 목록
const { slangList } = require('./slang');
// 관리자 도구 이벤트명
const adminCommandList = ['systemMessage', 'chatStop', 'getOutTrash', 'allConnectionOut', 'freeze', 'clean', 'notice', 'vote', 'banner-show', 'banner-hide'];

let pub = redis.createClient();
let sub = redis.createClient();

// Redis 채널 구독
sub.subscribe('chat-server');
// Redis 채널 리스너
sub.on('message', (ch, msg) => {

	if(ch === 'chat-server') {
		let obj = JSON.parse(msg);

		switch(obj.t) {
			case 'connect':
				connectedCnt++;
				break;
			case 'disconnect':
				connectedCnt--;
				break;
			case 'freeze':
				isFreeze = true;
				break;
			case 'unfreeze':
				isFreeze = false;
				break;
			case 'admin-connect':
				adminList[obj.nick] = {
					socket_id : obj.sid,
					socket_nick : obj.nick,
					user_id: obj.uid
				};
				connectedCnt++;
				break;
			case 'admin-disconnect':
				delete adminList[obj.nick];
				connectedCnt--;
				break;
			case 'owner-connect':
				connectedCnt++;
				owner = [obj.nick, obj.nick];
				break;
			case 'owner-disconnect':
				connectedCnt--;
				owner = []
				break;
			case 'chat-stop':
				trashList[obj.nick] = obj.time;
				break;
			case 'chat-release':
				delete trashList[obj.nick];
				break;
			case 'chat-out':
				trashList[obj.nick] = obj.t2;
				break;
			case 'console-connect':
				consoleList[obj.nick] = {
					socket_id : obj.sid,
					socket_nick : obj.nick,
					user_id: obj.uid
				};
				connectedCnt++;
				break;
			case 'console-disconnect':
				delete consoleList[obj.nick];
				connectedCnt--;
				break;
			case 'notice-insert':
				notice[obj.key] = { key: obj.key, message: obj.n };
				break;
			case 'notice-delete':
				delete notice[obj.k];
				break;
			case 'vote-start':
				vote = obj.o;
				break;
			case 'vote-end':
				vote = {};
				isVote = {};
				break;
			case 'vote-count':
				try {
					isVote[obj.unick] = 'voted';		   
					vote[obj.value].count++;	
				} catch {
					logging('사용자 투표 에러');
				}
				break;
			case 'adminConsoleLogging':
				adminConsoleLogging(obj.m);
				break;
			case 'publishAdminConsole':
				sendAdminConsole(obj.t2, obj.o);
				break;
			default:
				console.log('Undefined Object Type', obj);
		}
	}
});

// 소켓 채널 구독
io.sockets.on('connection', socket => {
	socket.use((data, next) => {
		// 사용자 첫 접속시
		if (data[0] === 'newUser') {
			authenticationUser(socket, data[1], next);
		} else {
			next();
		}
	});
	socket.use((data, next) => isLevelValidMiddleware(socket, data, next));
	
	// 사용자 소켓 접속시
	socket.on('newUser', data => {
		socket.user_id = data.user_id;
		socket.user_nick = data.user_nick;
		socket.level = data.level;

		// 사용자에 대한 제제사항 확인
		if(isTrash(socket.user_nick)) {
			if(trashList[socket.user_nick] == 'compulsion') {
				socket.disconnect();
			} else {
				socket.emit('chatStop', trashList[socket.user_nick] * 60000, 'reconnect');
			}
		}

		//중복세션 제거
		if(duplicateCheck(socket.user_nick)) {
		
			if (socket.level === ADMIN_USER_LEVEL) {
				if(data.type === 'admin') {
					adminList[socket.user_nick] = {socket_id : socket.id, socket_nick : socket.user_nick, user_id: socket.user_id};
				
					publish({
						t: 'admin-connect',
						sid: socket.id,
						uid: socket.user_id,
						nick: socket.user_nick
					});

					socket.emit('update', { type: 'new-admin', adminList: adminList, pid: pid });

					publishAdminConsole('update', { type: 'new-admin', adminList: adminList, pid: pid });
				} else if (data.type === 'console') {
					consoleList[socket.user_nick] = {socket_id : socket.id, socket_nick : socket.user_nick, user_id: socket.user_id};
					
					publish({
						t: 'console-connect',
						sid: socket.id,
						uid: socket.user_id,
						nick: socket.user_nick
					});
					
					socket.emit('update', { type: 'new-console', adminList: adminList, trashList: trashList, pid: pid });
				}
			} else if(socket.level == OWNER_USER_LEVEL) {
				owner = [socket.user_nick, socket.user_id];
			
				publish({
					t: 'owner-connect',
					nick: socket.user_nick,
					uid: socket.user_id
				});
			
				publishAdminConsole('update', { type: 'owner-connect', owner: owner, pid: pid  })
			} else {
				connectionList[socket.user_nick] = {socket_id : socket.id, socket_nick : socket.user_nick};

				publish({
					t: 'connect',
				});
			}
			
			socket.emit('update', { type : 'connect', name : 'SERVER', freeze : isFreeze, owner : owner, count: connectedCnt + 1, notice: notice });
		}
	});

	// 사용자 퇴장
	socket.on('disconnect', () => {
		// 검증되지 않은 사용자일 경우
		if (!socket.user_id) {
			return;
		}

		let pubObject = {};

		if(owner[0] == socket.user_nick) { // 중계자
			owner = [];

			pubObject = { t: 'owner-disconnect' };
            
			publishAdminConsole('update', { type: 'owner-disconnect', owner: owner, pid:pid  })
		} else if (socket.user_nick in adminList) { // 어드민
			try {
				delete adminList[socket.user_nick];

				pubObject = {
					t: 'admin-disconnect',
					nick: socket.user_nick,
				};
					
				publishAdminConsole('update', { type: 'admin-disconnect', adminList: adminList, pid:pid  })
			} catch {}
		} else if (socket.user_nick in consoleList){  //콘솔접속자
			try {
				delete consoleList[socket.user_nick];
				
				pubObject = {
					t: 'console-disconnect',
					nick: socket.user_nick,
				}

				publishAdminConsole('update', { type: 'console-disconnect', consoleList: consoleList, pid:pid  })
			} catch {}
		} else { // 일반 사용자
			try {
				delete connectionList[socket.user_nick];
				pubObject = { t: 'disconnect' }
			} catch(e) {
				console.log(e)
			};
		}
		
		publish(pubObject);
	});

	// 채팅 입력시
	socket.on('message', data => {
		console.log(11)
		// 제제된 사용자일경우
		if(isTrash(socket.user_nick)) {
			return;
		}

		if(!isFreeze || socket.level >= 4) {
			// 일반 유저일때
			if(socket.level != OWNER_USER_LEVEL && socket.level != ADMIN_USER_LEVEL) {
				let orig_msg = data.message, detected = false;
				console.log(slangList.length)

				// 비속어 필터 적용
				for(let i = 0; i < slangList.length; i++) {
					if(data.message.indexOf(slangList[i]) != -1) {
						data.message = '사랑해';
						detected = true;
						break;
					}
				}

				if(detected) {
					logging(`[비속어][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})] : ${orig_msg}`);
				}
                    
				// 100글자 제한
				data.message = data.message.substring(0, 100);
				socket.broadcast.emit('update', {user_nick : socket.user_nick, user_id : socket.user_id,  message : data.message});
			} else if(socket.level === OWNER_USER_LEVEL) {
				socket.broadcast.emit('update',  {type : 'owner_chat', user_nick : socket.user_nick,  message : data.message});
			} else if (socket.level === ADMIN_USER_LEVEL) {
				socket.broadcast.emit('update',  {type : 'admin_chat', user_nick : socket.user_nick,  message : data.message});
			}
			
			socket.emit('update', {
				type : 'mychat',
				user_nick : socket.user_nick,
				message : data.message
			});
		}
	});

	// 투표 참여
	socket.on('vote-count', obj => {
		let voteItem = vote[obj.value];
	   
		if(typeof(voteItem) != 'undefined') {
			if(typeof(isVote[socket.user_nick]) != 'undefined') {
				socket.emit('vote-duplicated', '이미 참여하셨습니다.');	
			} else {
				isVote[socket.user_nick] = 'voted';		   
				voteItem.count++;
				
				publish({
					unick: socket.user_nick,
					value: obj.value,
					t: 'vote-count'
				});
				
				socket.emit('vote-completed', '참여완료');	
			}
		} else {
			console.log('eerrr');
		}
	});

	//사용자 신고 (사용자가 사용자를 신고)
	socket.on('report', data => {
		publishAdminConsole('report', { user_nick: socket.user_nick, target_nick: data.nick, message: data.message, pid: pid });
		
		logging(`[신고][${socket.request.connection.remoteAddress}][${socket.user_nick}] => [${data.nick}] : ${data.message}`);
	});

	/**
	 * 관리자 도구
	 */
  
	// 공지 메세지 출력
	socket.on('systemMessage', message => {
		logging(`[시스템][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})] : ${message}`);
		
		io.sockets.emit('system', message);
	});

	// 채팅금지 n분
	socket.on('chatStop', (user_nick, time) => {
		chatStop(user_nick, time);
		logging(`[stop][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})] : ${user_nick}(${time}분)`);
	
		let socket_session = connectionList[user_nick];

		if(typeof(socket_session) != 'undefined') {
			io.sockets.connected[socket_session.socket_id].emit('chatStop', time * 60000, 'new');
		}
	});

	// 강제퇴장
	socket.on('getOutTrash', (user_nick) => {
		logging(`[trash][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})] : ${user_nick}`);

		let socket_session = connectionList[user_nick];
		
		trashList[user_nick] = 'compulsion';

		publish({
			t: 'chat-out',
			nick: user_nick,
			t2: 'compulsion'
		});
		
		publishAdminConsole('update', { type: 'new-stop', trashList: trashList, pid: pid });
		
		if(typeof(socket_session) != 'undefined') {
			io.sockets.connected[socket_session.socket_id].emit('compulsion');
			io.sockets.connected[socket_session.socket_id].disconnect();
		}
	});

	// 어드민을 제외한 모든 사용자 Connection Lost
	socket.on('allConnectionOut', () => {
		socket.broadcast.emit('allConnectionOut');
	});
  
	// 채팅창 얼림 && 녹임
	socket.on('freeze', () => {
		if(isFreeze){
			io.sockets.emit('freeze', { message : '채팅방이 녹았습니다.', isFreeze : false});

			publish({
				t: 'unfreeze',
			});
				
			logging(`[채팅녹음][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})]`);
		} else {
			io.sockets.emit('freeze', { message : '채팅방이 얼었습니다.', isFreeze : true});
	
			publish({
				t: 'freeze',
			})

			logging(`[채팅얼음][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})]`);
		}
	});

	// 채팅창 청소
	socket.on('clean', name  => {
		logging(`[청소][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})]`);
		io.sockets.emit('clean', name);
	});
	
  // 공지 추가 및 제거
	socket.on('notice', data => {
		if(data.type === 'insert') { // 공지 삽입
			notice[data.key] = { key: data.key, message: data.notice };

			publish({
				k: data.key,
				n: data.notice,
				t: 'notice-insert',
			});
				
			io.emit('update', {type : 'notice-insert', key: data.key, notice : data.notice});

			logging(`[공지등록][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})]`);
		} else if(data.type === 'delete') { // 공지 제거
			delete notice[data.key];
			
			publish({
				k: data.key,
				t: 'notice-delete',
			});
				
			io.emit('update', {type : 'notice-delete', key: data.key });
			
			logging(`[공지삭제][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})]`);
		}
	});
	
	// 투표 게시
	socket.on('vote', obj => {
		if(obj.type === 'start') {
			vote = obj.vote[Object.keys(obj.vote)[0]];
	
			publish({
				o: vote,
				t: 'vote-start'
			});
		    
			socket.broadcast.emit('vote-start', { list: obj.vote });
		    
			logging(`[투표등록][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})]`);
		} else if (obj.type === 'end') {
			if(Object.keys(vote).length === 0) {
				logging(`[투표종료실패][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})]`);
				return;
			}
			socket.broadcast.emit('vote-end', { result: vote, message: '투표가 마감되었습니다.' });
	        
			vote = {};
			isVote = {};
	        
			publish({
				t: 'vote-end'
			});

			logging(`[투표삭제][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})]`);
		}
	});
    
	// 배너 표시
	socket.on('banner-show', () => {
		io.emit('banner-show');
	});
    
	// 배너 숨기기
	socket.on('banner-hide', () => {
		io.emit('banner-hide');
	});
});

// 시그니처 검증
const isSignatureValid = (secret) => secret === SECRET;

//세션 중복체크
const duplicateCheck = user_nick => {
	let socket_session = connectionList[user_nick]; 

	if(typeof(socket_session) != 'undefined') {
		try {
			io.sockets.connected[socket_session.socket_id].disconnect();
		}
		catch {}
	}

	return true;
};

const isTrash = user_nick => {
	if(typeof(trashList[user_nick]) != 'undefined') {    	
		return true;
	}
	
	return false;
};

const chatStop = (user_nick, time) => {
	trashList[user_nick] = time;
	
	publish({
		t: 'chat-stop',
		nick: user_nick,
		time: time
	});
			
	publishAdminConsole('update', { type: 'new-stop', trashList: trashList, pid: pid });
	
	setTimeout(() => {
		let socket_session = connectionList[user_nick];
		
		if(typeof(socket_session) != 'undefined') {
			try {
				io.sockets.connected[socket_session.socket_id].emit('chatRelease');	
			} catch {}
		}
		delete trashList[user_nick];
		
		publish({
			t: 'chat-release',
			nick: user_nick,
		});
				
		publishAdminConsole('update', { type: 'release-stop', trashList: trashList, pid: pid });
	},(time * 60000));
};

// Redis Pub
const publish = (obj) =>{
	pub.publish('chat-server', JSON.stringify({pid, ...obj}));
};

// 어드민 콘솔 로깅
const logging = log => {
	publish({
		t: 'adminConsoleLogging',
		m: log,
	});

	// 서버의 현재 클러스터에만 로깅
	console.log(log);
};

//로그출력 및 콘솔에 로그 전송
const adminConsoleLogging = log => {
	for(const [k, v] of Object.entries(consoleList)) {
		try {
			io.sockets.connected[v.socket_id].emit('adm-console', {type: 'log', data: log, pid:pid });
		} catch {}
	}
};

//콘솔통신 redis
const publishAdminConsole = (type, obj) => {
	publish({
		t: 'publishAdminConsole',
		t2: type,
		o: obj	        
	});
};

//관리자 콘솔에만 보냄
const sendAdminConsole = (type, obj) => {
	for(const [k, v] of Object.entries(consoleList)) {
		try { 
			io.sockets.connected[v.socket_id].emit(type, obj);
		} catch {}
	}
};

// 사용자 검증 절차
const authenticationUser = (socket, data, next) => {
	try {
		// 어드민 && 중계자의 경우
		if (data.level >= OWNER_USER_LEVEL) {
			// 어드민 접속검증
			validateAdmin(socket, data.secret);
		} else {
			// 일반 사용자의 닉네임 검증
			validateUserNickname(socket, data.user_nick, data.nick_sig);
		}

		// 모든 사용자의 ID 검증
		validateUserId(data.user_id, data.id_sig);

		next();
	} catch (e) {
		logging(`[${socket.request.connection.remoteAddress}]`);
		logging(`${e.message}`);

		socket.disconnect();
	}
};

// 관리자 검증
const validateAdmin = (socket, userSecret) => {
	if (userSecret !== SECRET) {
		throw new Error(`검증되지 않은 관리자의 접속 시도 발생 : ${userSecret} || ${SECRET}`);
	}
};

// 일반 사용자 닉네임 검증
const validateUserNickname = (socket, userNickname, userNickSig) => {
	const nick_sig = crypto.createHash('sha256').update(userNickname + NICK_SALT).digest('base64');

	if(userNickSig !== nick_sig) {
		throw new Error(`조작된 닉네임 접속시도: ${nick_sig} || ${userNickSig} from ${userNickname}`);
	}
};

// 전체 사용자 ID 검증
const validateUserId = (userId, userIdSig) => {
	let idSig = crypto.createHash('sha256').update(userId + ID_SALT).digest('base64');

	if(userIdSig !== idSig) {
		throw new Error(`조작된 ID 접속시도: ${idSig} || ${userIdSig} from ${userId}`);
	}
}

// 관리자도구 사용에 대한 권한 검증 미들웨어
const isLevelValidMiddleware = (socket, data, next) => {
	// 관리자 도구 사용시
	if (adminCommandList.includes(data[0])) {
		if(socket.level == undefined || socket.level < OWNER_USER_LEVEL) {
			logging(`[비정상 ${data[0]}][${socket.request.connection.remoteAddress}][${socket.user_nick}(${socket.user_id})]`);
			socket.disconnect();
			return false;
		}
	}
		
	next();
};

// 시청자수 update job
setInterval(() => {
	const allConnections = Object.entries({...connectionList, ...adminList, ...consoleList});

	for(const [, v] of allConnections) {
		try {
			io.sockets.connected[v.socket_id].emit('update', {type: 'count', value: connectedCnt, pid:pid });
		} catch {}
	}
}, 7500);

server.listen(1029, () => {
	console.log('server running..');
});
