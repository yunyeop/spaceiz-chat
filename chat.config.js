module.exports = {
	apps: [{
		name: 'chat-dev',
		script: './app.js',
		instances: 0,
		exec_mode: 'cluster'
	}]
}
