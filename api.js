'use strict';

const Homey = require('homey');

module.exports = [
	{
		method: 'POST',
		path: '/webhook',
		public: true,
		fn(args, callback) {
			if (!Homey || !Homey.app || typeof Homey.app.getToonDevicesByCommonName !== 'function') {
				return callback(new Error('App not ready'));
			}
			if (!args || !args.hasOwnProperty('body') || !args.body.hasOwnProperty('commonName')) {
				return callback(new Error('Invalid body'));
			}
			const matchedDevices = Homey.app.getToonDevicesByCommonName(args.body.commonName);
			matchedDevices.forEach(device => device.processStatusUpdate({ body: args.body, test: '1' }));
			return callback(null, true);
		},
	},
];
