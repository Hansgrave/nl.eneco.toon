'use strict';

const Log = require('homey-log').Log;
const request = require('request');
const _ = require('underscore');
const EventEmitter = require('events').EventEmitter;

const apiBaseUrl = 'https://api.toonapi.com/toon/api/v1/';

class Toon extends EventEmitter {

	/**
	 * Toon constructor, provide the API key and secret.
	 * @constructor
	 */
	constructor(key, secret) {
		super();

		if (!key) console.error('node-toon: no client key provided');
		if (!secret) console.error('node-toon: no client secret provided');
		if (!key || !secret) return new Error('No client key or secret found in environment variables');

		// Store key and secret for authorization later on
		this.key = key;
		this.secret = secret;

		// Defaults
		this.targetTemperature = undefined;
		this.measureTemperature = undefined;
		this.meterGas = undefined;
		this.meterPower = undefined;
		this.temperatureState = undefined;
		this.offline = undefined;
		this.unAuthenticatedCounter = 0;
		this.refreshPromises = [];
		this.refreshPromise = undefined;

		// States map
		this.states = {
			comfort: 0,
			home: 1,
			sleep: 2,
			away: 3,
			none: -1
		};

		// Create fields for the access tokens
		this.accessToken = new Buffer(`${this.key}:${this.secret}`).toString('base64');
		this.refreshToken = undefined;

		console.log('node-toon: new Toon constructed');
	}

	/**
	 * Set the state of the device, overrides the program.
	 * @param state ['away', 'home', 'sleep', ['comfort']
	 */
	updateState(state, keepProgram) {

		let body = {
			temperatureState: this.states[state],
		};

		if (keepProgram) body.state = 2;

		console.log(`node-toon: set state to ${state} (${this.states[state]}), body:${JSON.stringify(body)}`);

		return this._put('temperature/states', body);
	}

	/**
	 * Enable the temperature program.
	 * @returns {*}
	 */
	enableProgram() {

		console.log('node-toon: enable program');

		return this._put('temperature/states', {
			state: 1,
		});
	}

	/**
	 * Disable the temperature program.
	 * @returns {*}
	 */
	disableProgram() {

		console.log('node-toon: disable program');

		return this._put('temperature/states', {
			state: 0,
		});
	}

	/**
	 * Destroy client, clean up.
	 */
	destroy() {
		clearInterval(this.pollInterval);
		console.log('node-toon: client destroyed');
	}

	/**
	 * Queries the Toon API for the display status.
	 */
	getStatus() {
		return new Promise((resolve, reject) => {
			console.log('node-toon: get status');

			if (!this.pollInterval) {
				this.pollInterval = setInterval(() => {
					this.getStatus();
				}, 60000);
			}

			Promise.all([this._get('status')]).then(result => {
				let initialized = false;

				// If no data available, this is probably the first time
				if (typeof this.measureTemperature === 'undefined'
					&& typeof this.targetTemperature === 'undefined'
					&& typeof this.meterPower === 'undefined'
					&& typeof this.meterGas === 'undefined') {
					initialized = true;
				}

				// Check for electricity data
				if (typeof result[1] !== 'undefined') {
					if (this.meterPower !== result[1] && typeof this.meterPower !== 'undefined') {
						this.emit('meterPower', result[1]);
					}
					this.meterPower = result[1];
				} else console.log('node-toon: no new electricity data available');

				// Check for gas data
				if (typeof result[2] !== 'undefined') {
					if (this.meterGas !== result[2] && typeof this.meterGas !== 'undefined') {
						this.emit('meterGas', result[2]);
					}
					this.meterGas = result[2];
				} else console.log('node-toon: no new gas data available');

				// Check for temperature data
				if (result[0] && result[0].thermostatInfo) {

					// Emit new values
					if (this.measureTemperature !== Math.round((result[0].thermostatInfo.currentTemp / 100) * 10) / 10
						&& typeof this.measureTemperature !== 'undefined') {
						this.emit('measureTemperature', Math.round((result[0].thermostatInfo.currentTemp / 100) * 10) / 10);
					}

					if (this.targetTemperature !== Math.round((result[0].thermostatInfo.currentSetpoint / 100) * 10) / 10
						&& typeof this.targetTemperature !== 'undefined') {
						this.emit('targetTemperature', Math.round((result[0].thermostatInfo.currentSetpoint / 100) * 10) / 10);
					}

					if (this.states[this.temperatureState] !== result[0].thermostatInfo.activeState
						&& typeof this.temperatureState !== 'undefined') {
						this.emit('temperatureState', Object.keys(this.states).filter(key => this.states[key] === result[0].thermostatInfo.activeState)[0]);
					}

					// Store new values
					if (result[0].thermostatInfo.currentTemp) {
						this.measureTemperature = Math.round((result[0].thermostatInfo.currentTemp / 100) * 10) / 10;
					}

					if (result[0].thermostatInfo.currentSetpoint) {
						this.targetTemperature = Math.round((result[0].thermostatInfo.currentSetpoint / 100) * 10) / 10;
					}

					if (result[0].thermostatInfo.activeState || result[0].thermostatInfo.activeState === -1) {
						this.temperatureState = Object.keys(this.states).filter(key => this.states[key] === result[0].thermostatInfo.activeState)[0];
					}

				} else console.log('node-toon: no new temperature data available');

				console.log('node-toon: get status complete');

				if (initialized) this.emit('initialized', this);

				return resolve({
					measureTemperature: this.measureTemperature,
					targetTemperature: this.targetTemperature,
					meterPower: this.meterPower,
					meterGas: this.meterGas,
					temperatureState: this.temperatureState,
				});
			}).catch(err => {
				console.log('node-toon: failed to get status, electricity or gas', err);
				return reject(err);
			});
		});
	}

	/**
	 * PUTs to the Toon API to set a new target temperature
	 * @param temperature temperature attribute of type integer.
	 */
	setTargetTemperature(temperature, preventRetry) {
		return new Promise((resolve, reject) => {

			if (!temperature) {
				console.error('node-toon: no temperature provided');
				return reject('missing target temperature');
			}

			console.log(`node-toon: set target temperature to ${temperature}`);

			this._put('temperature', { value: temperature * 100, scale: 'CELSIUS' }).then(() => {
				console.log(`node-toon: success setting temperature to ${temperature}`);
				this.targetTemperature = temperature;
				return resolve(temperature);
			}).catch(err => {
				console.error(`node-toon: failed to set temperature to ${temperature}`, err);

				if (!preventRetry) {

					// Retry in 3 seconds without retry to prevent loop
					setTimeout(() => {
						this.setTargetTemperature(temperature, true)
							.then(temperatureRetry => resolve(temperatureRetry))
							.catch(err => reject(err));
					}, 3000);
				}
			});
		});
	}

	/**
	 * Queries the Toon API for the electricity consumption.
	 * TODO only use peak? What is it?
	 */
	getConsumptionElectricity() {
		return new Promise(resolve => {
			this._get('consumption/electricity/data')
				.then(result => {
					if (result && result.hours) {
						const latest = _.max(result.hours, entry => entry.timestamp);
						if (!latest) return resolve();
						if (typeof latest.peak !== 'undefined') {
							return resolve(latest.peak / 1000);
						}
						return resolve();
					}
					return resolve();
				})
				.catch(err => {
					console.error('node-toon: error getConsumptionElectricity', err);
					return resolve();
				});
		});
	}

	/**
	 * Queries the Toon API for the gas consumption.
	 */
	getConsumptionGas() {
		return new Promise(resolve => {
			this._get('consumption/gas/data')
				.then(result => {
					if (result && result.hours) {
						const latest = _.max(result.hours, entry => entry.timestamp);
						if (!latest) return resolve();
						if (typeof latest.value !== 'undefined') {
							return resolve(latest.value / 1000);
						}
						return resolve();
					}
					return resolve();
				})
				.catch(err => {
					console.error('node-toon: error getConsumptionGas', err);
					return resolve();
				});
		});
	}

	/**
	 * Fetches all agreements from the API, if there are more
	 * than one, the user may choose one.
	 */
	getAgreements(stop) {
		return new Promise((resolve, reject) => {
			console.log('node-toon: get agreements');

			this._get('agreements').then(agreements => {
				if (agreements) {

					console.log(`node-toon: got ${agreements.length} agreements`);

					return resolve(agreements);
				}

				// Check if allowed to retry
				if (!stop) {

					// Try fetching agreements again
					this.getAgreements(true)
						.then(result => resolve(result))
						.catch(err => reject(err));

				} else {
					console.error('node-toon: failed to get agreements');
					return reject('node-toon: failed to get agreements');
				}
			}).catch(err => {
				console.error('node-toon: failed to get agreements', err);
				return reject(err);
			});
		});
	}

	/**
	 * Selects an agreement and registers it to this
	 * Toon object, this is a connection to the device.
	 * @param agreementId
	 */
	setAgreement(agreementId) {
		return new Promise((resolve, reject) => {

			// TODO test
			this.agreementId = agreementId;

			if (!agreementId) {
				console.error('node-toon: no agreementId provided');
				return reject('missing agreementId');
			}

			console.log(`node-toon: set agreement ${agreementId}`);

			// Make the request to set agreement
			this._post('agreements', { agreementId: agreementId }).then(result => {
				console.log('node-toon: successful post of agreement');

				// Fetch initial data
				this.getStatus()
					.then(() => resolve(result))
					.catch(err => reject(err));
			}).catch(err => {
				console.error('node-toon: failed to post agreement', err);
				return reject(err);
			});
		});
	}

	/**
	 * Fetches an access token from the Toon API using the
	 * Athom callback service (redirect uri).
	 * @param code
	 * @param redirectUri
	 */
	getAccessTokens(code, redirectUri) {
		return new Promise((resolve, reject) => {

			if (!redirectUri) {
				console.error('node-toon: no redirectUri provided when getting access tokens');
				return reject('missing redirectUri');
			}

			if (!code) {
				console.error('node-toon: no code provided when getting access tokens');
				return reject('missing code');
			}

			// Request accessToken
			this._request({
				url: 'https://api.toonapi.com/token',
				method: 'POST',
				form: {
					grant_type: 'authorization_code',
					client_id: this.key,
					client_secret: this.secret,
					redirect_uri: redirectUri,
					code: code,
				},
			}).then(body => {

				// Check for invalid body
				if (!body || !body.hasOwnProperty('access_token') || !body.hasOwnProperty('refresh_token')) {
					console.error('node-toon: error fetching access tokens');

					// Log.setExtra({
					// 	url: 'https://api.toonapi.com/token',
					// 	body: body
					// });
					// Log.captureException(new Error('Toon API responded with body does not contain access_token or refresh_token property'));

					return reject();
				}

				console.log('node-toon: fetched new access tokens');

				// Store new tokens
				this.accessToken = body.access_token;
				this.refreshToken = body.refresh_token;

				// Emit refreshed event
				this.emit('refreshed', { access_token: this.accessToken, refresh_token: this.refreshToken });

				// Callback new tokens
				return resolve({
					access_token: body.access_token,
					refresh_token: body.refresh_token,
				});
			}).catch(err => reject(err));
		});
	}

	/**
	 * Uses the refresh token to fetch a new access token,
	 * stores all new tokens internally.
	 * @private
	 */
	refreshAccessToken() {

		// Already refresh promise pending
		if (this.refreshPromise) {

			// Create and return substitute promise
			return new Promise((resolve, reject) => {

				// Store it for later access
				this.refreshPromises.push({ resolve: resolve, reject: reject });
			});
		}

		return new Promise((resolve, reject) => {

			if (!this.refreshToken) {
				console.error('node-toon: no refreshToken provided');
				return reject('missing refreshToken');
			}

			console.log('node-toon: perform refresh request');

			this.refreshPromise = this._request({
				url: 'https://api.toonapi.com/token',
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				form: {
					client_secret: this.secret,
					client_id: this.key,
					grant_type: 'refresh_token',
					refresh_token: this.refreshToken,
				},
			}).then(body => {

				// Check for invalid body
				if (!body || !body.hasOwnProperty('access_token') || !body.hasOwnProperty('refresh_token')) {
					console.log('node-toon: error fetching refreshed tokens');

					// Log.setExtra({
					// 	url: 'https://api.toonapi.com/token',
					// 	body: body
					// });
					// Log.captureException(new Error('Toon API responded with body does not contain access_token or refresh_token property'));

					return reject();
				}

				console.log('node-toon: fetched new access tokens');

				// Store new tokens
				this.accessToken = body.access_token;
				this.refreshToken = body.refresh_token;

				// Emit refreshed event
				this.emit('refreshed', { access_token: this.accessToken, refresh_token: this.refreshToken });

				// Resolve all queued promises
				this.refreshPromises.forEach(promise => {
					promise.resolve({
						access_token: body.access_token,
						refresh_token: body.refresh_token,
					});
				});

				// Reset this promise to open for new requests
				this.refreshPromise = null;

				// Callback new tokens
				return resolve({
					access_token: body.access_token,
					refresh_token: body.refresh_token,
				});

			}).catch(err => {

				// Resolve all queued promises
				this.refreshPromises.forEach(promise => {
					promise.reject(err);
				});

				// Reset this promise to open for new requests
				this.refreshPromise = null;
				return reject(err);
			});
		});
	}

	/**
	 * Convenience method that provides a basic PUT
	 * to the Toon API.
	 * @param command Desired command to be PUT
	 * @param body Data to be updated
	 * @private
	 */
	_put(command, body) {
		if (!command) return Promise.reject('node-toon: no command provided');
		if (!body) return Promise.reject('node-toon: no body provided');
		if (!this.accessToken) return Promise.reject('node-toon: no accesstoken provided');

		// Perform the request
		return this._request({
			url: `${apiBaseUrl}${command}`,
			method: 'PUT',
			headers: {
				authorization: `Bearer ${this.accessToken}`,
				Accept: 'application/json',
			},
			json: body,
		});
	}

	/**
	 * Convenience method that provides a basic GET
	 * to the Toon API.
	 * @param command Desired command to be GET
	 * @private
	 */
	_get(command) {
		if (!command) return Promise.reject('node-toon: no command provided');
		if (!this.accessToken) return Promise.reject('node-toon: no accesstoken provided');

		// Perform the request
		return this._request({
			url: `${apiBaseUrl}${command}`,
			method: 'GET',
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				Accept: 'application/json',
			},
		});
	}

	/**
	 * Convenience method that provides a basic POST
	 * to the Toon API.
	 * @param command Desired command to be POST
	 * @param data Data to POST
	 * @private
	 */
	_post(command, data) {
		if (!command) return Promise.reject('node-toon: no command provided');
		if (!data) return Promise.reject('node-toon: no body provided');
		if (!this.accessToken) return Promise.reject('node-toon: no accesstoken provided');

		// Perform the request
		return this._request({
			url: `${apiBaseUrl}${command}`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				Accept: 'application/json',
			},
			json: data,
		});
	}

	/**
	 * Check if response contains a communication
	 * error indicating that the device is offline.
	 * @param body
	 * @param parsed
	 * @returns {*} true if device is offline
	 * @private
	 */
	_checkForCommunicationError(body, parsed) {
		if (body) {

			// Check for offline display response
			if (body && body.code === 500 && body.type === 'communicationError') {
				this._markAsOffline();
				return true;
			}

			// If body was parsed before
			if (parsed) return false;

			// Check again after parsing
			return this._checkForCommunicationError(this._parseBody(body), true);
		}

		return false;
	}

	/**
	 * Parse the provided body if possible.
	 * @param body
	 * @returns {*}
	 * @private
	 */
	_parseBody(body) {
		if (!body) return false;

		// Parse body
		try {
			body = JSON.parse(body);
		} catch (err) {
			console.error('node-toon: error parsing body', body, err);
			return false;
		}

		return body;
	}

	/**
	 * Mark device as online.
	 * @private
	 */
	_markAsOnline() {
		this.offline = false;
		console.log('node-toon: device back online');
		this.emit('online');
	}

	/**
	 * Mark device as offline.
	 * @private
	 */
	_markAsOffline() {
		this.offline = true;
		console.log('node-toon: communicationError received, device offline');
		this.emit('offline');
	}

	/**
	 * Convenience method that performs a request to
	 * the Toon api, using the options provided in the
	 * parameter options.
	 * @param options Request options
	 * @param preventRetry If true, don't retry a failed request
	 * @private
	 */
	_request(options, preventRetry) {
		return new Promise((resolve, reject) => {
			if (!options) return reject('no options specified');

			// Start the request
			request(options, (error, response, body) => {
				if (!response) response = {};

				// Set logging context
				Log.setExtra({
					url: options.url,
					method: options.method,
					json: options.data,
					statusCode: response.statusCode,
					error: error,
					body: body
				});
				console.log(response.statusCode, body, error);
				// Do not try to parse 401 body, will cause error
				if (response.statusCode !== 401) {

					// Check for communication errors indicating device is offline
					if (this._checkForCommunicationError(body)) return reject('device is offline');
					if (options.url === `${apiBaseUrl}status`) {
						console.log(error, response.statusCode, body);
					}
					// Parse body if possible
					body = this._parseBody(body);
				}

				if (!error && response.statusCode === 200) {

					if (options.url === `${apiBaseUrl}status`) {
						console.log(error, response.statusCode, body);
					}
					// Toon is authenticated reset counter
					this.unAuthenticatedCounter = 0;

					// Mark as online when device was offline
					if (this.offline) {
						this._markAsOnline();
					}

					return resolve(body);
				} else if (response.statusCode === 401) {

					// Mark as online when device was offline
					if (this.offline) {
						this._markAsOnline();
					}

					// Add counter
					this.unAuthenticatedCounter++;

					// If more than 6 request failed due to 401, mark as unauthenticated
					if (this.unAuthenticatedCounter > 6) {
						this.emit('unauthenticated');
					}

					if (preventRetry) return reject(error || response.statusCode);

					console.log('node-toon: unauthorized, try refreshing');

					this.refreshAccessToken().then(() => {

						// Update access token
						if (options && options.headers['Authorization']) options.headers['Authorization'] = `Bearer ${this.accessToken}`;

						// Retry
						this._request(options, true).then(body => {
							console.log('node-toon: refresh and request succeeded');
							return resolve(body);
						}).catch(err => {
							console.error('node-toon: refresh succeeded but request failed', err);
							return reject(err);
						});

					}).catch(err => {
						console.error('node-toon: refresh failed, request failed', err);
						return reject(err);
					});
				} else if (response.statusCode === 500) {

					let errorTimeout = setTimeout(() => {
						// Log.captureException(new Error(`Toon API responded with ${response.statusCode}`));
					}, 10000);

					// Agreement might have expired, reset
					this.setAgreement(this.agreementId).then(() => {

						clearTimeout(errorTimeout);

						// Retry request
						this._request(options, true).then(body => {
							console.log('node-toon: after retry success');
							return resolve(body);
						}).catch(err => {
							console.error('node-toon: after retry failure', err);
							return reject(err);
						});
					}).catch(err => {
						console.error('node-toon: after retry set agreement fail', err);
						return reject(err);
					});
				} else if (error || response.statusCode !== 200) {
					// Log.captureException(new Error(`Toon API responded with an unknown error, statusCode ${response.statusCode}`));
					return reject((error || response.statusCode));
				}
			});
		});
	}
}

module.exports = Toon;
