"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 * Based on https://github.com/nVuln/homebridge-lg-thinq
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const crypto = require("crypto");
const uuid = require("uuid");
const qs = require("qs");
const { DateTime } = require("luxon");
const { extractKeys } = require("./lib/extractKeys");
const constants = require("./lib/constants");
const { URL } = require("url");
class LgThinq extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "lg-thinq",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.setState("info.connection", false, true);
        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }
        // @ts-ignore
        this.requestClient = axios.create();
        this.updateInterval = null;
        this.session = {};
        this.modelInfos = {};
        this.auth = {};
        this.workIds = [];
        this.deviceControls = {};
        this.extractKeys = extractKeys;
        this.subscribeStates("*");

        this.defaultHeaders = {
            "x-api-key": constants.API_KEY,
            "x-client-id": constants.API_CLIENT_ID,
            "x-thinq-app-ver": "3.5.1700",
            "x-thinq-app-type": "NUTS",
            "x-thinq-app-level": "PRD",
            "x-thinq-app-os": "ANDROID",
            "x-thinq-app-logintype": "LGE",
            "x-service-code": "SVC202",
            "x-country-code": this.config.country,
            "x-language-code": this.config.language,
            "x-service-phase": "OP",
            "x-origin": "app-native",
            "x-model-name": "samsung / SM-N950N",
            "x-os-version": "7.1.2",
            "x-app-version": "3.5.1721",
            "x-message-id": this.random_string(22),
        };

        this.gateway = await this.requestClient
            .get(constants.GATEWAY_URL, { headers: this.defaultHeaders })
            .then((res) => res.data.result)
            .catch((error) => {
                this.log.error(error);
            });
        if (this.gateway) {
            this.lgeapi_url = `https://${this.gateway.countryCode.toLowerCase()}.lgeapi.com/`;

            this.session = await this.login(this.config.user, this.config.password).catch((error) => {
                this.log.error(error);
            });
            if (this.session && this.session.access_token) {
                this.log.debug(JSON.stringify(this.session));
                this.setState("info.connection", true, true);
                this.log.info("Login successful");
                this.refreshTokenInterval = setInterval(() => {
                    this.refreshNewToken();
                }, this.session.expires_in * 1000);
                this.userNumber = await this.getUserNumber();
                this.defaultHeaders["x-user-no"] = this.userNumber;
                this.defaultHeaders["x-emp-token"] = this.session.access_token;
                const listDevices = await this.getListDevices();

                this.log.info("Found: " + listDevices.length + " devices");
                listDevices.forEach(async (element) => {
                    await this.setObjectNotExistsAsync(element.deviceId, {
                        type: "device",
                        common: {
                            name: element.alias,
                            role: "indicator",
                        },
                        native: {},
                    });
                    this.extractKeys(this, element.deviceId, element, null, false, true);
                    this.modelInfos[element.deviceId] = await this.getDeviceModelInfo(element);
                    await this.pollMonitor(element);
                    await this.sleep(2000);
                    this.extractValues(element);
                });

                this.log.debug(JSON.stringify(listDevices));
                this.updateInterval = setInterval(async () => {
                    const listDevices = await this.getListDevices().catch((error) => {
                        this.log.error(error);
                    });

                    listDevices.forEach(async (element) => {
                        this.extractKeys(this, element.deviceId, element);
                        this.pollMonitor(element);
                    });
                    this.log.debug(JSON.stringify(listDevices));
                }, this.config.interval * 60 * 1000);
            }
        }
    }

    async login(username, password) {
        // get signature and timestamp in login form
        const loginForm = await this.requestClient.get(await this.getLoginUrl()).then((res) => res.data);
        const headers = {
            Accept: "application/json",
            "X-Application-Key": constants.APPLICATION_KEY,
            "X-Client-App-Key": constants.CLIENT_ID,
            "X-Lge-Svccode": "SVC709",
            "X-Device-Type": "M01",
            "X-Device-Platform": "ADR",
            "X-Device-Language-Type": "IETF",
            "X-Device-Publish-Flag": "Y",
            "X-Device-Country": this.gateway.countryCode,
            "X-Device-Language": this.gateway.languageCode,
            "X-Signature": loginForm.match(/signature\s+:\s+"([^"]+)"/)[1],
            "X-Timestamp": loginForm.match(/tStamp\s+:\s+"([^"]+)"/)[1],
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        };

        const hash = crypto.createHash("sha512");
        const data = {
            user_auth2: hash.update(password).digest("hex"),
            itg_terms_use_flag: "Y",
            svc_list: "SVC202,SVC710", // SVC202=LG SmartHome, SVC710=EMP OAuth
        };

        // try login with username and hashed password
        const loginUrl = this.gateway.empTermsUri + "/" + "emp/v2.0/account/session/" + encodeURIComponent(username);
        const res = await this.requestClient
            .post(loginUrl, qs.stringify(data), { headers })
            .then((res) => res.data)
            .catch((err) => {
                if (!err.response) {
                    this.log.error(err);
                    return;
                }
                this.log.error(JSON.stringify(err.response.data));
                const { code, message } = err.response.data.error;
                if (code === "MS.001.03") {
                    this.log.error("Double-check your country in configuration");
                }
                return;
            });

        // dynamic get secret key for emp signature
        const empSearchKeyUrl = this.gateway.empSpxUri + "/" + "searchKey?key_name=OAUTH_SECRETKEY&sever_type=OP";
        const secretKey = await this.requestClient
            .get(empSearchKeyUrl)
            .then((res) => res.data)
            .then((data) => data.returnData);

        const timestamp = DateTime.utc().toRFC2822();
        const empData = {
            account_type: res.account.userIDType,
            client_id: constants.CLIENT_ID,
            country_code: res.account.country,
            username: res.account.userID,
        };
        const empUrl = "/emp/oauth2/token/empsession" + qs.stringify(empData, { addQueryPrefix: true });
        const signature = this.signature(`${empUrl}\n${timestamp}`, secretKey);
        const empHeaders = {
            "lgemp-x-app-key": constants.OAUTH_CLIENT_KEY,
            "lgemp-x-date": timestamp,
            "lgemp-x-session-key": res.account.loginSessionID,
            "lgemp-x-signature": signature,
            Accept: "application/json",
            "X-Device-Type": "M01",
            "X-Device-Platform": "ADR",
            "Content-Type": "application/x-www-form-urlencoded",
            "Access-Control-Allow-Origin": "*",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept-Language": "en-US,en;q=0.9",
        };
        // create emp session and get access token
        const token = await this.requestClient
            .post("https://emp-oauth.lgecloud.com/emp/oauth2/token/empsession", qs.stringify(empData), {
                headers: empHeaders,
            })
            .then((res) => res.data)
            .catch((err) => {
                this.log.error(err.response.data.error.message);
                return;
            });
        if (token.status !== 1) {
            this.log.error(token.message);
            return;
        }

        this.lgeapi_url = token.oauth2_backend_url || this.lgeapi_url;

        return token;
    }

    async pollMonitor(device) {
        if (device.platformType === "thinq1") {
            this.log.debug("start polling");
            let result = new Uint8Array(1024);
            try {
                if (!(device.deviceId in this.workIds)) {
                    this.log.debug(device.deviceId + " is connecting");
                    await this.startMonitor(device);
                    await this.sleep(2000);
                }
                result = await this.getMonitorResult(device.deviceId, this.workIds[device.deviceId]);
                if (result && typeof result === "object") {
                    const resultConverted = this.decodeMonitorBinary(result, this.modelInfos[device.deviceId].Monitoring.protocol);
                    this.log.debug(JSON.stringify(resultConverted));
                    await extractKeys(this, device.deviceId + ".snapshot", resultConverted);
                    return resultConverted;
                } else {
                    this.log.debug("No data:" + JSON.stringify(result));
                }
                await this.stopMonitor(device);
            } catch (err) {
                this.log.error(err);
            }
        }
    }
    async startMonitor(device) {
        try {
            if (device.platformType === "thinq1") {
                this.workIds[device.deviceId] = await this.sendMonitorCommand(device.deviceId, "Start", uuid.v4()).then((data) => data.workId);
            }
        } catch (err) {
            this.log.error(err);
        }
    }

    async stopMonitor(device) {
        if (device.platformType === "thinq1" && device.deviceId in this.workIds) {
            try {
                await this.sendMonitorCommand(device.deviceId, "Stop", this.workIds[device.deviceId]);
                delete this.workIds[device.deviceId];
            } catch (err) {
                this.log.error(err);
            }
        }
    }
    decodeMonitorBinary(data, protocol) {
        const decoded = {};

        for (const item of protocol) {
            const key = item.value;
            let value = 0;

            for (let i = item.startByte; i < item.startByte + item.length; i++) {
                const v = data[i];
                value = (value << 8) + v;
                decoded[key] = String(value);
            }
        }

        return decoded;
    }
    async refreshNewToken() {
        this.log.debug("refreshToken");
        const tokenUrl = this.lgeapi_url + "oauth2/token";
        const data = {
            grant_type: "refresh_token",
            refresh_token: this.session.refresh_token,
        };

        const timestamp = DateTime.utc().toRFC2822();

        const requestUrl = "/oauth2/token" + qs.stringify(data, { addQueryPrefix: true });
        const signature = this.signature(`${requestUrl}\n${timestamp}`, constants.OAUTH_SECRET_KEY);

        const headers = {
            "lgemp-x-app-key": constants.CLIENT_ID,
            "lgemp-x-signature": signature,
            "lgemp-x-date": timestamp,
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        };
        const resp = await this.requestClient.post(tokenUrl, qs.stringify(data), { headers }).then((resp) => resp.data);
        this.log.debug(JSON.stringify(resp));
        if (this.session) {
            this.session.access_token = resp.access_token;
            this.defaultHeaders["x-emp-token"] = this.session.access_token;
        }
    }

    async getUserNumber() {
        const profileUrl = this.lgeapi_url + "users/profile";
        const timestamp = DateTime.utc().toRFC2822();
        const signature = this.signature(`/users/profile\n${timestamp}`, constants.OAUTH_SECRET_KEY);

        const headers = {
            Accept: "application/json",
            Authorization: "Bearer " + this.session.access_token,
            "X-Lge-Svccode": "SVC202",
            "X-Application-Key": constants.APPLICATION_KEY,
            "lgemp-x-app-key": constants.CLIENT_ID,
            "X-Device-Type": "M01",
            "X-Device-Platform": "ADR",
            "x-lge-oauth-date": timestamp,
            "x-lge-oauth-signature": signature,
        };

        const resp = await this.requestClient.get(profileUrl, { headers }).then((resp) => resp.data);
        this.extractKeys(this, "general", resp);
        return resp.account.userNo;
    }

    async getLoginUrl() {
        const params = {
            country: this.gateway.countryCode,
            language: this.gateway.languageCode,
            client_id: constants.CLIENT_ID,
            svc_list: constants.SVC_CODE,
            svc_integrated: "Y",
            redirect_uri: this.gateway.empSpxUri + "/" + "login/iabClose",
            show_thirdparty_login: "LGE,MYLG",
            division: "ha:T20",
            callback_url: this.gateway.empSpxUri + "/" + "login/iabClose",
        };

        return this.gateway.empSpxUri + "/" + "login/signIn" + qs.stringify(params, { addQueryPrefix: true });
    }

    async sendMonitorCommand(deviceId, cmdOpt, workId) {
        const headers = Object.assign({}, this.defaultHeaders);
        headers["x-client-id"] = constants.API1_CLIENT_ID;
        const data = {
            cmd: "Mon",
            cmdOpt,
            deviceId,
            workId,
        };
        return await this.requestClient
            .post(this.gateway.thinq1Uri + "/" + "rti/rtiMon", { lgedmRoot: data }, { headers })
            .then((res) => res.data.lgedmRoot)
            .then((data) => {
                if ("returnCd" in data) {
                    const code = data.returnCd;
                    if (code === "0106") {
                        this.log.error(data.returnMsg || "");
                    } else if (code !== "0000") {
                        this.log.error(code + " - " + data.returnMsg || "");
                    }
                }
                this.log.debug(JSON.stringify(data));
                return data;
            });
    }

    async getMonitorResult(device_id, work_id) {
        const headers = Object.assign({}, this.defaultHeaders);
        headers["x-client-id"] = constants.API1_CLIENT_ID;
        const workList = [{ deviceId: device_id, workId: work_id }];
        return await this.requestClient
            .post(this.gateway.thinq1Uri + "/" + "rti/rtiResult", { lgedmRoot: { workList } }, { headers })
            .then((resp) => resp.data.lgedmRoot)
            .then((data) => {
                if ("returnCd" in data) {
                    const code = data.returnCd;
                    if (code === "0106") {
                        return code;
                    } else if (code !== "0000") {
                        this.log.error(code + " - " + data.returnMsg || "");
                        return code;
                    }
                }
                this.log.debug(JSON.stringify(data));
                const workList = data.workList;
                if (!workList || workList.returnCode !== "0000") {
                    this.log.debug(JSON.stringify(data));
                    return null;
                }

                if (!("returnData" in workList)) {
                    return null;
                }

                return Buffer.from(workList.returnData, "base64");
            });
    }

    signature(message, secret) {
        return crypto.createHmac("sha1", Buffer.from(secret)).update(message).digest("base64");
    }
    random_string(length) {
        const result = [];
        const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
            result.push(characters.charAt(Math.floor(Math.random() * charactersLength)));
        }
        return result.join("");
    }
    resolveUrl(from, to) {
        const url = new URL(to, from);
        return url.href;
    }
    async getDeviceInfo(deviceId) {
        const headers = this.defaultHeaders;
        const deviceUrl = this.resolveUrl(this.gateway.thinq2Uri + "/", "service/devices/" + deviceId);

        return this.requestClient.get(deviceUrl, { headers }).then((res) => res.data.result);
    }

    async getListDevices() {
        if (!this.homes) {
            this.homes = await this.getListHomes();
            this.extractKeys(this, "homes", this.homes);
        }
        const headers = this.defaultHeaders;
        const devices = [];

        // get all devices in home
        for (let i = 0; i < this.homes.length; i++) {
            const homeUrl = this.resolveUrl(this.gateway.thinq2Uri + "/", "service/homes/" + this.homes[i].homeId);
            const resp = await this.requestClient
                .get(homeUrl, { headers })
                .then((res) => res.data)
                .catch((error) => {
                    this.log.error(error);
                    if (error.response && error.response.data) {
                        this.log.error(JSON.stringify(error.response.data));
                    }
                    if (error.response && error.response.status === 400) {
                        this.log.info("Try to refresh Token");
                        this.refreshNewToken();
                    }
                    return;
                });

            this.log.debug(JSON.stringify(resp));
            if (resp) {
                this.log.debug(JSON.stringify(resp));
                devices.push(...resp.result.devices);
            }
        }

        return devices;
    }

    async getListHomes() {
        if (!this._homes) {
            const headers = this.defaultHeaders;
            const homesUrl = this.resolveUrl(this.gateway.thinq2Uri + "/", "service/homes");
            this._homes = await this.requestClient
                .get(homesUrl, { headers })
                .then((res) => res.data)
                .then((data) => data.result.item);
        }

        return this._homes;
    }
    async getDeviceModelInfo(device) {
        if (!device.modelJsonUri) {
            return;
        }
        const deviceModel = await this.requestClient
            .get(device.modelJsonUri)
            .then((res) => res.data)
            .catch((error) => {
                this.log.error(error);
                return;
            });
        if (deviceModel) {
            await this.setObjectNotExistsAsync(device.deviceId + ".remote", {
                type: "channel",
                common: {
                    name: "remote control device",
                    role: "indicator",
                },
                native: {},
            });
            if (deviceModel["ControlWifi"]) {
                let controlWifi = deviceModel["ControlWifi"];
                if ((controlWifi.type = "BINARY(BYTE)")) {
                    controlWifi = deviceModel["ControlWifi"].action;
                }
                this.deviceControls[device.deviceId] = controlWifi;

                const controlId = deviceModel["Info"].productType + "Control";
                await this.setObjectNotExistsAsync(device.deviceId + ".remote", {
                    type: "channel",
                    common: {
                        name: "remote control device",
                        role: "indicator",
                    },
                    native: {},
                });
                Object.keys(controlWifi).forEach((control) => {
                    this.setObjectNotExists(device.deviceId + ".remote." + control, {
                        type: "state",
                        common: {
                            name: control,
                            type: "boolean",
                            role: "boolean",
                            write: true,
                            read: true,
                        },
                        native: {},
                    });
                });
            }
        }
        return deviceModel;
    }
    extractValues(device) {
        const deviceModel = this.modelInfos[device.deviceId];
        if (deviceModel["MonitoringValue"] || deviceModel["Value"]) {
            this.log.debug("extract values from model");
            let type = "";
            if (device["snapshot"]) {
                Object.keys(device["snapshot"]).forEach((subElement) => {
                    if (subElement !== "meta" && subElement !== "static" && typeof device["snapshot"][subElement] === "object") {
                        type = subElement;
                    }
                });
            }
            let path = device.deviceId + ".snapshot.";
            if (type) {
                path = path + type + ".";
            }

            deviceModel["MonitoringValue"] &&
                Object.keys(deviceModel["MonitoringValue"]).forEach((state) => {
                    this.getObject(path + state, async (err, obj) => {
                        if (obj) {
                            const common = obj.common;
                            common.states = {};
                            if (deviceModel["MonitoringValue"][state]["valueMapping"]) {
                                if (deviceModel["MonitoringValue"][state]["valueMapping"].max) {
                                    common.min = 0; // deviceModel["MonitoringValue"][state]["valueMapping"].min; //reseverdhour has wrong value
                                    common.max = deviceModel["MonitoringValue"][state]["valueMapping"].max;
                                } else {
                                    const values = Object.keys(deviceModel["MonitoringValue"][state]["valueMapping"]);
                                    values.forEach((value) => {
                                        common.states[value] = value;
                                    });
                                }
                            }
                            // @ts-ignore
                            await this.setObjectNotExistsAsync(path + state, {
                                type: "state",
                                common: common,
                                native: {},
                            }).catch((error) => {
                                this.log.error(error);
                            });

                            // @ts-ignore
                            this.extendObject(path + state, {
                                common: common,
                            });
                        }
                    });
                });
            deviceModel["Value"] &&
                Object.keys(deviceModel["Value"]).forEach((state) => {
                    this.getObject(path + state, async (err, obj) => {
                        if (obj) {
                            const common = obj.common;
                            common.states = {};
                            let valueObject = deviceModel["Value"][state]["option"];
                            if (deviceModel["Value"][state]["value_mapping"]) {
                                valueObject = deviceModel["Value"][state]["value_mapping"];
                            }
                            if (valueObject) {
                                if (valueObject.max) {
                                    common.min = 0; // deviceModel["MonitoringValue"][state]["valueMapping"].min; //reseverdhour has wrong value
                                    common.max = valueObject.max;
                                } else {
                                    const values = Object.keys(valueObject);
                                    values.forEach((value) => {
                                        let content = valueObject[value];
                                        if (typeof content === "string") {
                                            common.states[value] = content.replace("@", "");
                                        }
                                    });
                                }
                            }
                            // @ts-ignore
                            await this.setObjectNotExistsAsync(path + state, {
                                type: "state",
                                common: common,
                                native: {},
                            }).catch((error) => {
                                this.log.error(error);
                            });

                            // @ts-ignore
                            this.extendObject(path + state, {
                                common: common,
                            });
                        }
                    });
                });
        }
    }

    async sendCommandToDevice(deviceId, values) {
        const headers = this.defaultHeaders;
        const controlUrl = this.resolveUrl(this.gateway.thinq2Uri + "/", "service/devices/" + deviceId + "/control-sync");
        return this.requestClient
            .post(
                controlUrl,
                {
                    ctrlKey: "basicCtrl",
                    command: "Set",
                    ...values,
                },
                { headers }
            )
            .then((resp) => resp.data)
            .catch((error) => {
                this.log.error(error);
            });
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            clearInterval(this.updateInterval);
            clearInterval(this.refreshTokenInterval);

            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state) {
            if (!state.ack) {
                const deviceId = id.split(".")[2];
                if (id.indexOf(".remote.") !== -1 && state.val) {
                    const action = id.split(".")[4];
                    const rawData = this.deviceControls[deviceId][action];
                    const data = { ctrlKey: action, command: rawData.command, dataSetList: rawData.data };

                    if (action === "WMStop" || action === "WMOff") {
                        data.ctrlKey = "WMControl";
                    }
                    this.log.debug(JSON.stringify(data));
                    const response = await this.sendCommandToDevice(deviceId, data);
                    this.log.debug(JSON.stringify(response));
                    if (response && response.resultCode !== "0000") {
                        this.log.error("Command not succesful");
                        this.log.error(JSON.stringify(response));
                    }
                } else {
                    const object = await this.getObjectAsync(id);
                    const name = object.common.name;
                    const data = { ctrlKey: "basicCtrl", command: "Set", dataKey: name, dataValue: state.val };
                    if (name.indexOf(".operation") !== -1) {
                        data.command = "Operation";
                    }
                    this.log.debug(JSON.stringify(data));
                    const response = await this.sendCommandToDevice(deviceId, data);
                    this.log.debug(JSON.stringify(response));
                    if (response && response.resultCode !== "0000") {
                        this.log.error("Command not succesful");
                        this.log.error(JSON.stringify(response));
                    }
                }
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new LgThinq(options);
} else {
    // otherwise start the instance directly
    new LgThinq();
}
