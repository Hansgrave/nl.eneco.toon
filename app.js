'use strict';

const Homey = require('homey');
const Log = require('homey-log').Log;

class ToonApp extends Homey.App {
	async onInit() {
		this.log(`${this.id} running...`);

		// TODO: remove after nl.eneco.toon@2.1.6 hits stable
		setTimeout(async () => {
			const notificationSendAlready = Homey.ManagerSettings.get('max_one_device_notification_send');
			const installedDevices = Homey.ManagerDrivers.getDriver('toon').getDevices();
			if (!notificationSendAlready && installedDevices.length > 1) {
				const notification = new Homey.Notification({ excerpt: Homey.__('max_one_device_notification') });
				await notification.register();
				Homey.ManagerSettings.set('max_one_device_notification_send', true);
				this.log('Send warning notification about max one device');
			}
		}, 5000); // TODO: hacky, getDevices returns [] if called directly upon init
	}

	getToonDevicesByCommonName(commonName) {
		return Homey.ManagerDrivers.getDriver('toon')
			.getDevices()
			.filter(device => device.getData().id === commonName);
	}
}

module.exports = ToonApp;
