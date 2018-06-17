const Client = require('kubernetes-client').Client;
const config = require('kubernetes-client').config;
const _ = require('lodash');
const Promise = require('bluebird');
const eventmesh = require('./');
const errors = require('../common/errors');
const ETCDLockError = errors.ETCDLockError;
const logger = require('../common/logger');
const CONST = require('../common/constants');

class ApiServerLockManager {

    isWriteLocked(resourceName) {
        return eventmesh.server.getLockResourceOptions(CONST.RESOURCE_TYPES.LOCK, CONST.RESOURCE_NAMES.DEPLOYMENT_LOCKS, resourceName)
            .then(options => {
                const currentTime = new Date();
                const lockDetails = JSON.parse(options);
                const lockTime = new Date(lockDetails.lockTime);
                const lockTTL = lockDetails.lockTTL ? lockDetails.lockTTL : Infinity;
                if (lockDetails.lockType === CONST.ETCD.LOCK_TYPE.WRITE && ((currentTime - lockTime) < lockTTL)) {
                    return true;
                }
                return false;
            })
            .catch(err => {
                if (err.code === CONST.HTTP_STATUS_CODE.NOT_FOUND) {
                    return false;
                }
                throw err;
            });
    }

    lock(resourceName, lockDetails) {
        if (!lockDetails) {
            lockDetails = {};
        }
        const currentTime = new Date();
        const opts = _.cloneDeep(lockDetails);
        opts.lockTime = new Date();
        opts.lockTTL = opts.lockTTL ? opts.lockTTL : Infinity;
        _.extend(opts, { 'lockTime': currentTime });
        return eventmesh.server.getLockResourceOptions(CONST.RESOURCE_TYPES.LOCK, CONST.RESOURCE_NAMES.DEPLOYMENT_LOCKS, resourceName)
            .then(options => {
                const currentlLockDetails = JSON.parse(options);
                const currentLockTTL = currentlLockDetails.lockTTL ? currentlLockDetails.lockTTL : Infinity;
                const currentLockTime = new Date(currentlLockDetails.lockTime);
                if ((currentTime - currentLockTime) < currentLockTTL) {
                    logger.info(`Resource ${resourceName} is locked`);
                    throw new ETCDLockError(`Error: resource ${resourceName} is locked`);
                }
                else {
                    const patchBody = {
                        spec: { options: JSON.stringify(opts) }
                    };
                    return eventmesh.server.updateLockResource(CONST.RESOURCE_TYPES.LOCK, CONST.RESOURCE_NAMES.DEPLOYMENT_LOCKS, resourceName, patchBody);
                }
            })
            .catch(err => {
                if (err.code === CONST.HTTP_STATUS_CODE.NOT_FOUND) {
                    const spec = {
                        options: JSON.stringify(opts)
                    };
                    const status = {
                        locked: 'true'
                    }
                    const body = {
                        apiVersion: "lock.servicefabrik.io/v1alpha1",
                        metadata: {
                            name: resourceName
                        },
                        spec: spec,
                        status: status
                    };
                    return eventmesh.server.createLockResource(CONST.RESOURCE_TYPES.LOCK, CONST.RESOURCE_NAMES.DEPLOYMENT_LOCKS, body);
                }
                throw err;
            })
    }

    unlock(resourceName) {
        return eventmesh.server.deleteLockResource(CONST.RESOURCE_TYPES.LOCK, CONST.RESOURCE_NAMES.DEPLOYMENT_LOCKS, resourceName)
            .then(() => logger.info(`Successfully Unlocked resource ${resourceName}`))
            .catch(err => {
                if (err.code === CONST.HTTP_STATUS_CODE.NOT_FOUND) {
                    logger.info(`Successfully Unlocked resource ${resourceName}`);
                    return;
                }
                logger.error('Error: ', err);
                throw err;
            })
    }
}

module.exports = ApiServerLockManager;