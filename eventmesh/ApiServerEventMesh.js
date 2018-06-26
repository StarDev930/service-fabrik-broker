'use strict';

const Promise = require('bluebird');
const assert = require('assert');
const config = require('../common/config');
const logger = require('../common/logger');
const CONST = require('../common/constants');
const EventMeshServer = require('./EventMeshServer');
const kc = require('kubernetes-client');
const JSONStream = require('json-stream');
const errors = require('../common/errors');
const BadRequest = errors.BadRequest;
const NotFound = errors.NotFound;
const Conflict = errors.Conflict;
const InternalServerError = errors.InternalServerError;

const apiserver = new kc.Client({
  config: {
    url: `https://${config.internal.ip}:9443`,
    insecureSkipTlsVerify: true
  },
  version: '1.9'
});

function buildErrors(err) {
  let throwErr;
  switch (err.code) {
  case CONST.HTTP_STATUS_CODE.BAD_REQUEST:
    throwErr = new BadRequest(err.message);
    break;
  case CONST.HTTP_STATUS_CODE.NOT_FOUND:
    throwErr = new NotFound(err.message);
    break;
  case CONST.HTTP_STATUS_CODE.CONFLICT:
    throwErr = new Conflict(err.message);
    break;
  default:
    throwErr = new InternalServerError(err.message);
    break;
  }
  throw throwErr;
}

class ApiServerEventMesh extends EventMeshServer {
  /**
   *
   * @param {string} resourceName
   * @param {string} resourceType
   * @param {string} callback
   */
  registerWatcher(resourceName, resourceType, callback) {
    return Promise.try(() => apiserver.loadSpec())
      .then(() => {
        const stream = apiserver
          .apis[`${resourceName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
          .watch.namespaces(CONST.APISERVER.NAMESPACE)[resourceType].getStream();
        const jsonStream = new JSONStream();
        stream.pipe(jsonStream);
        jsonStream.on('data', callback);
      })
      .catch(err => {
        return buildErrors(err);
      });
  }

  createResource(resourceName, resourceType, body) {
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver
        .apis[`${resourceName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[resourceType].post({
          body: body
        }));
  }

  createLockResource(name, type, body) {
    return this.createResource(name, type, body)
      .catch(err => {
        return buildErrors(err);
      });
  }

  deleteResource(resourceName, resourceType, resourceId) {
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver.apis[`${resourceName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[resourceType](resourceId).delete());
  }

  patchResource(resourceName, resourceType, resourceId, delta) {
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver.apis[`${resourceName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[resourceType](resourceId).patch({
          body: delta
        }));
  }

  deleteLockResource(resourceName, resourceType, resourceId) {
    return this.deleteResource(resourceName, resourceType, resourceId)
      .catch(err => {
        return buildErrors(err);
      });
  }

  updateResource(resourceName, resourceType, resourceId, delta) {
    return this.patchResource(resourceName, resourceType, resourceId, delta)
      .catch(err => {
        return buildErrors(err);
      });
  }

  getLockResourceOptions(resourceName, resourceType, resourceId) {
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver.apis[`${resourceName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[resourceType](resourceId).get())
      .then(resource => {
        return resource.body.spec.options;
      })
      .catch(err => {
        return buildErrors(err);
      });
  }

  getResource(resourceName, resourceType, resourceId) {
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver.apis[`${resourceName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[resourceType](resourceId).get())
      .catch(err => {
        return buildErrors(err);
      });
  }

  createDeploymentResource(resourceType, resourceId, val) {
    const opts = {
      operationId: resourceId,
      resourceId: resourceId,
      operationName: CONST.APISERVER.RESOURCE_TYPES.DEPLOYMENT,
      operationType: CONST.APISERVER.RESOURCE_NAMES.DIRECTOR,
      val: val
    };
    return this.createOperationResource(opts);
  }

  updateResourceState(resourceType, resourceId, stateValue) {
    const opts = {
      operationId: resourceId,
      resourceId: resourceId,
      operationName: CONST.APISERVER.RESOURCE_TYPES.DEPLOYMENT,
      operationType: resourceType,
      stateValue: stateValue
    };
    return this.updateOperationState(opts);
  }

  getResourceState(resourceType, resourceId) {
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver
        .apis[`${CONST.APISERVER.RESOURCE_TYPES.DEPLOYMENT}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[resourceType](resourceId)
        .get())
      .then(json => json.body.status.state)
      .catch(err => {
        return buildErrors(err);
      });
  }

  /**
   *
   * @param {string} opts.resourceId
   * @param {string} opts.operationName
   * @param {string} opts.operationType
   * @param {string} opts.operationId
   * @param {Object} opts.val
   */
  createOperationResource(opts) {
    logger.info('Creating resource with options:', opts.val);
    const initialResource = {
      metadata: {
        'name': `${opts.operationId}`,
        'labels': {
          instance_guid: `${opts.resourceId}`,
        },
      },
      spec: {
        'options': JSON.stringify(opts.val)
      },
    };
    const statusJson = {
      status: {
        state: CONST.APISERVER.RESOURCE_STATE.IN_QUEUE,
        lastOperation: 'created',
        response: JSON.stringify({})
      }
    };
    return this.createResource(opts.operationName, opts.operationType, initialResource)
      .then(() => apiserver.apis[`${opts.operationName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[opts.operationType](opts.operationId).status.patch({
          body: statusJson
        }))
      .catch(err => {
        return buildErrors(err);
      });
  }
  /**
   * @param {string} opts.operationName
   * @param {string} opts.operationType
   * @param {string} opts.operationId
   * @param {Object} opts.value
   */
  updateOperationResult(opts) {
    logger.info('Updating Operation Result with :', opts);
    const patchedResource = {
      'status': {
        'response': JSON.stringify(opts.value),
      }
    };
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver
        .apis[`${opts.operationName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[opts.operationType](opts.operationId)
        .status.patch({
          body: patchedResource
        }))
      .catch(err => {
        return buildErrors(err);
      });
  }

  /**
   * @param {string} opts.operationName
   * @param {string} opts.operationType
   * @param {string} opts.operationId
   * @param {Object} opts.stateValue
   */
  updateOperationState(opts) {
    logger.info('Updating Operation State with :', opts);
    assert.ok(opts.operationName, `Property 'operationName' is required to update operation state`);
    assert.ok(opts.operationType, `Property 'operationType' is required to update operation state`);
    assert.ok(opts.operationId, `Property 'operationId' is required to update operation state`);
    assert.ok(opts.stateValue, `Property 'stateValue' is required to update operation state`);
    const patchedResource = {
      'status': {
        'state': opts.stateValue
      }
    };
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver
        .apis[`${opts.operationName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[opts.operationType](opts.operationId)
        .status.patch({
          body: patchedResource
        }))
      .catch(err => {
        return buildErrors(err);
      });
  }

  /**
   * @param {string} opts.resourceId
   * @param {string} opts.operationName
   * @param {string} opts.operationType
   * @param {Object} opts.value
   */
  updateLastOperation(opts) {
    const patchedResource = {};
    patchedResource.metadata = {};
    patchedResource.metadata.labels = {};
    patchedResource.metadata.labels[`last_${opts.operationName}_${opts.operationType}`] = opts.value;
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver
        .apis[`${CONST.APISERVER.RESOURCE_TYPES.DEPLOYMENT}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[CONST.APISERVER.RESOURCE_NAMES.DIRECTOR](opts.resourceId)
        .patch({
          body: patchedResource
        }))
      .catch(err => {
        return buildErrors(err);
      });
  }

  /**
   * @param {string} opts.resourceId
   * @param {string} opts.operationName
   * @param {string} opts.operationType
   */
  getLastOperation(opts) {
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver
        .apis[`${CONST.APISERVER.RESOURCE_TYPES.DEPLOYMENT}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[CONST.APISERVER.RESOURCE_NAMES.DIRECTOR](opts.resourceId)
        .get())
      .then(json => json.body.metadata.labels[`last_${opts.operationName}_${opts.operationType}`])
      .catch(err => {
        return buildErrors(err);
      });
  }

  /**
   * @param {string} opts.operationName
   * @param {string} opts.operationType
   * @param {string} opts.operationId
   */
  getOperationOptions(opts) {
    assert.ok(opts.operationName, `Property 'operationName' is required to get operation state`);
    assert.ok(opts.operationType, `Property 'operationType' is required to get operation state`);
    assert.ok(opts.operationId, `Property 'operationId' is required to get operation state`);
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver
        .apis[`${opts.operationName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[opts.operationType](opts.operationId)
        .get())
      .then(json => json.body.spec.options)
      .catch(err => {
        return buildErrors(err);
      });
  }

  /**
   * @param {string} opts.operationName
   * @param {string} opts.operationType
   * @param {string} opts.operationId
   */
  getOperationState(opts) {
    assert.ok(opts.operationName, `Property 'operationName' is required to get operation state`);
    assert.ok(opts.operationType, `Property 'operationType' is required to get operation state`);
    assert.ok(opts.operationId, `Property 'operationId' is required to get operation state`);
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver
        .apis[`${opts.operationName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[opts.operationType](opts.operationId)
        .get())
      .then(json => json.body.status.state)
      .catch(err => {
        return buildErrors(err);
      });
  }

  /**
   * @param {string} opts.operationName
   * @param {string} opts.operationType
   * @param {string} opts.operationId
   */
  getOperationResult(opts) {
    return Promise.try(() => apiserver.loadSpec())
      .then(() => apiserver
        .apis[`${opts.operationName}.${CONST.APISERVER.HOSTNAME}`][CONST.APISERVER.API_VERSION]
        .namespaces(CONST.APISERVER.NAMESPACE)[opts.operationType](opts.operationId)
        .get())
      .tap(json => logger.info('Debug:', json))
      .then(json => json.body.status.response)
      .catch(err => {
        return buildErrors(err);
      });
  }

}

module.exports = ApiServerEventMesh;