'use strict';

const Homey = require('homey');
const OAuth2Device = require('homey-wifidriver').OAuth2Device;

const TEMPERATURE_STATES = {
	comfort: 0,
	home: 1,
	sleep: 2,
	away: 3,
	none: -1
};

/**
 * TODO: GET webhooks before registering a new one
 */
class ToonDevice extends OAuth2Device {

	/**
	 * This method will be called when a new device has been added
	 * or when the driver reboots with installed devices. It creates
	 * a new ToonAPI client and sets the correct agreement.
	 */
	async onInit() {
		await super.onInit({
			apiBaseUrl: `https://api.toon.eu/toon/v3/`,
			throttle: 200,
			rateLimit: {
				max: 15,
				per: 60000,
			},
		}).catch(err => {
			this.error('Error onInit', err.stack);
			return err;
		});

		this.log('init ToonDevice');

		// Store raw data
		this.gasUsage = {};
		this.powerUsage = {};
		this.thermostatInfo = {};

		// Device needs to be re-paired on with API v3
		const apiVersion = this.getStoreValue('apiVersion');
		if (!apiVersion || apiVersion !== 3) {
			this.log('migration re-pair needed', Homey.__('repair_migration_v3'));
			return this.setUnavailable(Homey.__('repair_migration_v3'), null, true);
		}

		// Indicate Homey is connecting to Toon
		this.setUnavailable(Homey.__('connecting'));

		// Register poll interval for refreshing access tokens
		this.registerPollInterval({
			id: 'refreshTokens',
			fn: this.oauth2Account.refreshAccessTokens.bind(this.oauth2Account),
			interval: 6 * 60 * 60 * 1000, // 6 hours
		});

		// Refresh tokens (in case Homey has been offline for a while)
		try {
			await this.oauth2Account.refreshAccessTokens();
		} catch (err) {
			this.error('onInit() -> refresh access tokens failed', err);
		}

		// Register capability listeners
		this.registerCapabilityListener('temperature_state', this.onCapabilityTemperatureState.bind(this));
		this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));

		// Start subscription
		await this.registerWebhookSubscription();

		// Fetch initial data
		await this.getStatusUpdate();
	}

	/**
	 * This method will be called when the target temperature needs to be changed.
	 * @param temperature
	 * @param options
	 * @returns {Promise}
	 */
	onCapabilityTargetTemperature(temperature, options) {
		this.log('onCapabilityTargetTemperature()', 'temperature:', temperature, 'options:', options);
		return this.setTargetTemperature(Math.round(temperature * 2) / 2);
	}

	/**
	 * This method will be called when the temperature state needs to be changed.
	 * @param state
	 * @param resumeProgram Abort or resume program
	 * @returns {Promise}
	 */
	onCapabilityTemperatureState(state, resumeProgram) {
		this.log('onCapabilityTemperatureState()', 'state:', state, 'resumeProgram:', resumeProgram);
		return this.updateState(state, resumeProgram);
	}

	/**
	 * Method that will request a subscription for webhook events for the next hour.
	 * @returns {Promise<void>}
	 */
	async registerWebhookSubscription() {
		let webhookIsRegistered = false;

		this.log('registerWebhookSubscription()');

		// Refresh webhooks after 15 minutes of inactivity
		clearTimeout(this._registerWebhookSubscriptionTimeout);
		this._registerWebhookSubscriptionTimeout = setTimeout(() => this.registerWebhookSubscription(), 1000 * 60 * 15);

		// TODO: get current webhook
		// try {
		// 	const webhooks = await this.apiCallGet({ uri: `${this.getData().agreementId}/webhooks` });
		//
		// 	// Detect if a webhook was already registered by Homey
		// 	if (Array.isArray(webhooks)) {
		// 		webhooks.forEach(webhook => {
		// 			if (webhook.applicationId === Homey.env.TOON_KEY && webhook.callbackUrl === Homey.env.WEBHOOK_CALLBACK_URL) {
		// 				webhookIsRegistered = true;
		// 			}
		// 		})
		// 	}
		// } catch (err) {
		// 	this.error('failed to get existing subscriptions', err.message);
		// }

		// Start new subscription if not yet registered
		if (!webhookIsRegistered) {
			try {
			  const homeyId = await Homey.ManagerCloud.getHomeyId();
				await this.apiCallPost({
					uri: `${this.getData().agreementId}/webhooks`,
					json: {
						applicationId: Homey.env.TOON_KEY,
						callbackUrl: `https://${homeyId}.connect.athom.com/api/app/nl.eneco.toon/webhook`,
						subscribedActions: ['Thermostat', 'PowerUsage', 'GasUsage']
					}
				});
			} catch (err) {
				this.error('failed to register webhook subscription', err.message);

				// Pass error
				throw err;
			}
		}
	}

	/**
	 * This method will retrieve temperature, gas and electricity data from the Toon API.
	 * @returns {Promise}
	 */
	async getStatusUpdate() {
		try {
			const data = await this.apiCallGet({ uri: `${this.getData().agreementId}/status` });
			this.processStatusUpdate({ body: { updateDataSet: data } });
		} catch (err) {
			this.error('failed to retrieve status update', err.message);
		}
	}

	/**
	 * Set the state of the device, overrides the program.
	 * @param state ['away', 'home', 'sleep', 'comfort']
	 * @param keepProgram - if true program will resume after state change
	 */
	async updateState(state, keepProgram) {
		const stateId = TEMPERATURE_STATES[state];
		const data = { ...this.thermostatInfo, activeState: stateId, programState: keepProgram ? 2 : 0 };

		this.log(`set state to ${stateId} (${state}), data: {activeState: ${stateId}}`);

		try {
			await this.apiCallPut({ uri: `${this.getData().agreementId}/thermostat` }, data);
		} catch (err) {
			this.error(`failed to set temperature state to ${state} (${stateId})`, err.stack);
			throw err;
		}

		this.log(`success setting temperature state to ${state} (${stateId})`);
		return state;
	}

	/**
	 * PUTs to the Toon API to set a new target temperature
	 * TODO doesn't work flawlessly every time (maybe due to multiple webhooks coming in simultaneously)
	 * @param temperature temperature attribute of type integer.
	 */
	async setTargetTemperature(temperature) {
		const data = { ...this.thermostatInfo, currentSetpoint: temperature * 100, programState: 2, activeState: -1 };

		this.log(`set target temperature to ${temperature}`);

		if (!temperature) {
			this.error('no temperature provided');
			return Promise.reject(new Error('missing_temperature_argument'));
		}

		this.setCapabilityValue('target_temperature', temperature);

		return this.apiCallPut({ uri: `${this.getData().agreementId}/thermostat` }, data)
			.then(() => {
				this.log(`success setting temperature to ${temperature}`);
				return temperature;
			}).catch(err => {
				this.error(`failed to set temperature to ${temperature}`, err.stack);
				throw err;
			});
	}

	/**
	 * Enable the temperature program.
	 * @returns {*}
	 */
	enableProgram() {
		this.log('enable program');
		const data = { ...this.thermostatInfo, programState: 1 };
		return this.apiCallPut({ uri: `${this.getData().agreementId}/thermostat` }, data)
	}

	/**
	 * Disable the temperature program.
	 * @returns {*}
	 */
	disableProgram() {
		this.log('disable program');
		const data = { ...this.thermostatInfo, programState: 0 };
		return this.apiCallPut({ uri: `${this.getData().agreementId}/thermostat` }, data)
	}

	/**
	 * Method that handles processing an incoming status update, whether it is from a GET /status request or a webhook
	 * update.
	 * @param data
	 * @private
	 */
	processStatusUpdate(data) {

		// Data needs to be unwrapped
		if (data && data.hasOwnProperty('body') && data.body.hasOwnProperty('updateDataSet')) {

			// Prevent parsing data from other displays
			if (data.body.hasOwnProperty('commonName') && data.body.commonName !== this.getData().id) return;

			// Setup registration timeout
			if (this._webhookRegistrationTimeout) clearTimeout();
			this._webhookRegistrationTimeout = setTimeout(this.registerWebhookSubscription.bind(this), data.body.timeToLiveSeconds * 1000);

			const dataRootObject = data.body.updateDataSet;

			// Check for power usage information
			if (dataRootObject.hasOwnProperty('powerUsage')) {
				this._processPowerUsageData(dataRootObject.powerUsage);
			}

			// Check for gas usage information
			if (dataRootObject.hasOwnProperty('gasUsage')) {
				this._processGasUsageData(dataRootObject.gasUsage);
			}

			// Check for thermostat information
			if (dataRootObject.hasOwnProperty('thermostatInfo')) {
				this._processThermostatInfoData(dataRootObject.thermostatInfo);
			}
		}
	}

	/**
	 * Method that handles the parsing of updated power usage data.
	 * @param data
	 * @private
	 */
	_processPowerUsageData(data = {}) {
		this.log('process received powerUsage data');
		this.log(data);

		// Store data object
		this.powerUsage = data;

		// Store new values
		if (data.hasOwnProperty('value')) {
			this.log('getThermostatData() -> powerUsage -> measure_power -> value:', data.value);
			this.setCapabilityValue('measure_power', data.value);
		}

		// Store new values
		if (data.hasOwnProperty('dayUsage') && data.hasOwnProperty('dayLowUsage')) {
			const usage = (data.dayUsage + data.dayLowUsage) / 1000; // convert from Wh to KWh
			this.log('getThermostatData() -> powerUsage -> meter_power -> dayUsage:', data.dayUsage + ', dayLowUsage:' + data.dayLowUsage + ', usage:' + usage);
			this.setCapabilityValue('meter_power', usage);
		}
	}

	/**
	 * Method that handles the parsing of updated gas usage data.
	 * TODO: validate this method once GasUsage becomes available.
	 * @param data
	 * @private
	 */
	_processGasUsageData(data = {}) {
		this.log('process received gasUsage data');
		this.log(data);

		// Store data object
		this.gasUsage = data;

		// Store new values
		if (data.hasOwnProperty('dayUsage')) {
			const meterGas = data.dayUsage / 1000; // Wh -> kWh
			this.log('getThermostatData() -> gasUsage -> meter_gas', meterGas);
			this.setCapabilityValue('meter_gas', meterGas);
		}
	}

	/**
	 * Method that handles the parsing of thermostat info data.
	 * @param data
	 * @private
	 */
	_processThermostatInfoData(data = {}) {
		this.log('process received thermostatInfo data');
		this.log(data);

		// Store data object
		this.thermostatInfo = data;

		// Store new values
		if (data.hasOwnProperty('currentDisplayTemp')) {
			this.setCapabilityValue('measure_temperature', Math.round((data.currentDisplayTemp / 100) * 10) / 10);
		}
		if (data.hasOwnProperty('currentSetpoint')) {
			this.setCapabilityValue('target_temperature', Math.round((data.currentSetpoint / 100) * 10) / 10);
		}
		if (data.hasOwnProperty('activeState')) {
			this.setCapabilityValue('temperature_state', ToonDevice.getKey(TEMPERATURE_STATES, data.activeState));
		}
	}

	/**
	 * This method will be called when the device has been deleted, it makes
	 * sure the client is properly destroyed and left over settings are removed.
	 */
	onDeleted() {
		this.log('onDeleted()');
		super.onDeleted();
	}

	/**
	 * Method that overrides device.setAvailable to reset a unavailable counter.
	 * @returns {*|Promise}
	 */
	setAvailable() {
		this._unavailableCounter = 0;
		if (this.getAvailable() === false) {
			this.log('mark as available');
			return super.setAvailable();
		}
		return Promise.resolve();
	}

	/**
	 * Method that overrides device.setUnavailable so that the super only gets called when setUnavailable is called
	 * more than three times.
	 * @param args
	 * @returns {*}
	 */
	setUnavailable(message, callback, force) {
		if (this._unavailableCounter > 3 || force) {
			this.log('mark as unavailable');
			return super.setUnavailable(message, callback);
		}
		this._unavailableCounter = this._unavailableCounter + 1;
		return Promise.resolve();
	}

	/**
	 * Response handler middleware, which will be called on each successful API request.
	 * @param res
	 * @returns {*}
	 */
	webAPIResponseHandler(res) {
		// Mark device as available after being unavailable
		if (this.getAvailable() === false) this.setAvailable();
		return res;
	}

	/**
	 * Response handler middleware, which will be called on each failed API request.
	 * @param err
	 * @returns {*}
	 */
	webAPIErrorHandler(err) {
		this.error('webAPIErrorHandler()', err);

		// Detect error that is returned when Toon is offline
		if (err.name === 'WebAPIServerError' && err.statusCode === 500) {

			if (err.errorResponse.type === 'communicationError' || err.errorResponse.errorCode === 'communicationError' ||
				err.errorResponse.description === 'Error communicating with Toon') {
				this.log('webAPIErrorHandler() -> communication error');
				this.setUnavailable(Homey.__('offline'));

				throw err;
			}
		}

		// Let OAuth2/WebAPIDevice handle the error
		super.webAPIErrorHandler(err);
	}

	/**
	 * Utility method that will return the first key of an object that matches a provided value.
	 * @param obj
	 * @param val
	 * @returns {string | undefined}
	 */
	static getKey(obj, val) {
		return Object.keys(obj).find(key => obj[key] === val);
	}
}

// Returns a function, that, as long as it continues to be invoked, will not
// be triggered. The function will be called after it stops being called for
// N milliseconds. If `immediate` is passed, trigger the function on the
// leading edge, instead of the trailing.
function debounce(func, wait, immediate) {
	var timeout;
	return function () {
		var context = this, args = arguments;
		var later = function () {
			timeout = null;
			if (!immediate) func.apply(context, args);
		};
		var callNow = immediate && !timeout;
		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
		if (callNow) func.apply(context, args);
	};
};

module.exports = ToonDevice;
