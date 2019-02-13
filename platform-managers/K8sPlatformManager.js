'use strict';

const BasePlatformManager = require('./BasePlatformManager');
const Promise = require('bluebird');

class K8sPlatformManager extends BasePlatformManager {
  constructor(platform) {
    super(platform);
    this.platform = platform;
  }

  preUnbindOperations(options) {
    return Promise.resolve();
  }

  preBindOperations(options) {
    return Promise.resolve();
  }

  postBindOperations(options) {
    return Promise.resolve();
  }

  postInstanceProvisionOperations(options) {
    /* jshint unused:false */
  }

  preInstanceDeleteOperations(options) {
    /* jshint unused:false */
  }

  postInstanceUpdateOperations(options) {
    /* jshint unused:false */
  }

  ensureTenantId(options) {
    /* jshint unused:false */
  }

}
module.exports = K8sPlatformManager;