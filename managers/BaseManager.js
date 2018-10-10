'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const errors = require('../common/errors');
const logger = require('../common/logger');
const config = require('../common/config');
const eventmesh = require('../data-access-layer/eventmesh');
const CONST = require('../common/constants');
const NotImplementedBySubclass = errors.NotImplementedBySubclass;
const Conflict = errors.Conflict;
const NotFound = errors.NotFound;

class BaseManager {

  registerCrds(resourceGroup, resourceType) {
    return eventmesh.apiServerClient.registerCrds(resourceGroup, resourceType);
  }

  registerWatcher(resourceGroup, resourceType, validStateList, handler, watchRefreshInterval) {
    const queryString = `state in (${_.join(validStateList, ',')})`;
    logger.debug(`Registering watcher for resourceGroup ${resourceGroup} of type ${resourceType} with queryString as ${queryString}`);
    return eventmesh.apiServerClient.registerWatcher(resourceGroup, resourceType, (resource) => this.handleResource(resource, handler, resourceGroup, resourceType, queryString), queryString)
      .then(stream => {
        logger.debug(`Successfully set watcher with query string:`, queryString);
        watchRefreshInterval = watchRefreshInterval || CONST.APISERVER.WATCHER_REFRESH_INTERVAL;
        logger.info(`Refreshing stream for resourceGroup ${resourceGroup} of type ${resourceType} with queryString  ${queryString} at interval of ${watchRefreshInterval}`);
        return Promise
          .delay(watchRefreshInterval)
          .then(() => {
            logger.debug(`Refreshing stream after ${watchRefreshInterval || CONST.APISERVER.WATCHER_REFRESH_INTERVAL}`);
            stream.abort();
            return this.registerWatcher(resourceGroup, resourceType, validStateList, handler, watchRefreshInterval);
          });
      })
      .catch(e => {
        logger.error(`Error occured in registerWatcher:`, e);
        return Promise
          .delay(CONST.APISERVER.WATCHER_ERROR_DELAY)
          .then(() => {
            logger.info(`Refreshing stream after ${CONST.APISERVER.WATCHER_ERROR_DELAY}`);
            return this.registerWatcher(resourceGroup, resourceType, validStateList, handler, watchRefreshInterval);
          });
      });
  }

  /**
   * @description Patches resource with annotation key lockedByManager and value broker ip
   */
  _acquireProcessingLock(changeObjectBody) {
    const changedOptions = JSON.parse(changeObjectBody.spec.options);
    logger.silly('Trying to acquire processing lock for request with options: ', changedOptions);
    // Set lockedManager annotations to true
    const patchBody = _.cloneDeep(changeObjectBody);
    const metadata = patchBody.metadata;
    const patchAnnotations = metadata.annotations ? metadata.annotations : {};
    patchAnnotations.lockedByManager = config.broker_ip;
    patchAnnotations.processingStartedAt = new Date();
    metadata.annotations = patchAnnotations;
    const resourceDetails = eventmesh.apiServerClient.parseResourceDetailsFromSelfLink(changeObjectBody.metadata.selfLink);
    return eventmesh.apiServerClient.updateResource({
        resourceGroup: resourceDetails.resourceGroup,
        resourceType: resourceDetails.resourceType,
        resourceId: metadata.name,
        metadata: metadata
      })
      .tap((resource) => logger.silly(`Successfully acquired processing lock for request with options: ${JSON.stringify(changedOptions)}\n\
        Updated resource with annotations is:`, resource));
  }

  /**
   * @description Sets lockedByManager annotation to empty string
   */

  _releaseProcessingLock(changeObjectBody) {
    const changedOptions = JSON.parse(changeObjectBody.spec.options);
    logger.silly('Trying to release processing lock for request with options: ', changedOptions);
    const metadata = {
      annotations: {
        lockedByManager: '',
        processingStartedAt: ''
      }
    };
    const resourceDetails = eventmesh.apiServerClient.parseResourceDetailsFromSelfLink(changeObjectBody.metadata.selfLink);
    return eventmesh.apiServerClient.updateResource({
        resourceGroup: resourceDetails.resourceGroup,
        resourceType: resourceDetails.resourceType,
        resourceId: changeObjectBody.metadata.name,
        metadata: metadata
      })
      .tap((resource) => logger.silly(`Successfully released processing lock for the request with options: ${JSON.stringify(changedOptions)} \n` +
        `Updated resource with annotations is: `, resource));
  }

  _preProcessRequest(objectBody, processingLockStatus, resourceGroup, resourceType, queryString) {
    const options = JSON.parse(objectBody.spec.options);
    // Acquire processing lock so that in HA scenerio, only one backup-manager process processes the request
    return Promise.try(() => {
      let processingConflict = false;
      const lockedByManager = _.get(objectBody, 'metadata.annotations.lockedByManager');
      const processingStartedAt = _.get(objectBody, 'metadata.annotations.processingStartedAt');
      // To handle already existing resources
      // For already existing resources lockedByManager value is either '' or '<ip>' or undefined
      if (
        lockedByManager &&
        (lockedByManager !== '') &&
        processingStartedAt &&
        (processingStartedAt !== '') &&
        (new Date() - new Date(processingStartedAt) < CONST.PROCESSING_REQUEST_BY_MANAGER_TIMEOUT)
      ) {
        processingConflict = true;
      }

      if (!processingConflict) {
        return this._acquireProcessingLock(objectBody)
          .catch(err => {
            processingLockStatus.conflict = true;
            if (err instanceof Conflict) {
              logger.info(`Not able to acquire processing lock, Request with options ${JSON.stringify(options)} is probably picked by other worker`);
            } else {
              logger.error(`Error while trying to get processing lock for request with options ${JSON.stringify(options)} `, err);
            }
            throw err;
          });
      } else {
        processingLockStatus.conflict = true;
        logger.debug(`Resource ${objectBody.metadata.name}  ${resourceGroup}, ${resourceType}, ${queryString} - is picked by process with ip ${lockedByManager} at ${processingStartedAt}`);
      }
    });
  }

  _postProcessRequest(objectBody) {
    const options = JSON.parse(objectBody.spec.options);
    return this._releaseProcessingLock(objectBody)
      .catch((NotFound), () => logger.debug(`Resource resourceType: ${objectBody.kind},\`
        resourceId: ${objectBody.metadata.name} is not found, No need to panic as it is already deleted.`))
      .catch(err => logger.error(`Caught error while releasing processing lock for request ${JSON.stringify(options)}:`, err));
  }

  processRequest() {
    throw new NotImplementedBySubclass('processRequest');
  }

  continueToHoldLock(resourceBody) {
    return this._acquireProcessingLock(resourceBody);
  }

  handleResource(changeObject, handler, resourceGroup, resourceType, queryString) {
    logger.debug(`Handling Resource:-, ${changeObject.object.metadata.name}, ${resourceGroup}, ${resourceType}, ${queryString}`);
    logger.debug('Changed resource:', changeObject);
    const changeObjectBody = changeObject.object;
    const changedOptions = JSON.parse(changeObjectBody.spec.options);
    logger.silly('Changed resource options(parsed):', changedOptions);
    const processingLockStatus = {
      conflict: false
    };
    let releaseProcessingLock = true;
    return this
      ._preProcessRequest(changeObjectBody, processingLockStatus, resourceGroup, resourceType, queryString)
      .then(() => {
        if (!processingLockStatus.conflict) {
          if (handler) {
            return handler(changeObjectBody);
          }
          return this.processRequest(changeObjectBody);
        }
      })
      .tap((releaseLock) => releaseProcessingLock = releaseLock !== 'HOLD_PROCESSING_LOCK')
      .catch(err => {
        if (!processingLockStatus.conflict) {
          logger.error(`Caught error while processing request with options ${JSON.stringify(changedOptions)} `, err);
        }
      })
      .finally(() => {
        if (!releaseProcessingLock) {
          logger.info(`${changeObject.object.metadata.name} is requesting lock not to be released! Continue to hold lock!!!`);
        }
        if (!processingLockStatus.conflict && releaseProcessingLock) {
          return this._postProcessRequest(changeObjectBody);
        }
      });
  }

}

module.exports = BaseManager;