/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'path';
// ESLint doesn't know about this experimental module
// eslint-disable-next-line import/no-unresolved
import {Worker} from 'worker_threads';

import {
  CHILD_MESSAGE_INITIALIZE,
  PARENT_MESSAGE_OK,
  PARENT_MESSAGE_CLIENT_ERROR,
  PARENT_MESSAGE_SETUP_ERROR,
  ChildMessage,
  OnEnd,
  OnStart,
  WorkerOptions,
  WorkerInterface,
  ParentMessage,
} from '../types';

export default class ExperimentalWorker implements WorkerInterface {
  _worker!: Worker;
  _options: WorkerOptions;
  _onProcessEnd!: OnEnd;
  _retries!: number;

  constructor(options: WorkerOptions) {
    this._options = options;
    this.initialize();
  }

  initialize() {
    this._worker = new Worker(path.resolve(__dirname, './threadChild.js'), {
      eval: false,
      stderr: true,
      stdout: true,
      workerData: {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JEST_WORKER_ID: String(this._options.workerId),
        } as NodeJS.ProcessEnv,
        // Suppress --debug / --inspect flags while preserving others (like --harmony).
        execArgv: process.execArgv.filter(v => !/^--(debug|inspect)/.test(v)),
        silent: true,
        ...this._options.forkOptions,
      },
    });

    this._worker.on('message', this.onMessage.bind(this));
    this._worker.on('exit', this.onExit.bind(this));

    this._worker.postMessage([
      CHILD_MESSAGE_INITIALIZE,
      false,
      this._options.workerPath,
      this._options.setupArgs,
    ]);

    this._retries++;

    // If we exceeded the amount of retries, we will emulate an error reply
    // coming from the child. This avoids code duplication related with cleaning
    // the queue, and scheduling the next call.
    if (this._retries > this._options.maxRetries) {
      const error = new Error('Call retries were exceeded');

      this.onMessage([
        PARENT_MESSAGE_CLIENT_ERROR,
        error.name,
        error.message,
        error.stack!,
        {type: 'WorkerError'},
      ]);
    }
  }

  onMessage(response: ParentMessage) {
    let error;

    switch (response[0]) {
      case PARENT_MESSAGE_OK:
        this._onProcessEnd(null, response[1]);
        break;

      case PARENT_MESSAGE_CLIENT_ERROR:
        error = response[4];

        if (error != null && typeof error === 'object') {
          const extra = error;
          // @ts-ignore: no index
          const NativeCtor = global[response[1]];
          const Ctor = typeof NativeCtor === 'function' ? NativeCtor : Error;

          error = new Ctor(response[2]);
          error.type = response[1];
          error.stack = response[3];

          for (const key in extra) {
            // @ts-ignore: no index
            error[key] = extra[key];
          }
        }

        this._onProcessEnd(error, null);
        break;
      case PARENT_MESSAGE_SETUP_ERROR:
        error = new Error('Error when calling setup: ' + response[2]);

        // @ts-ignore: adding custom properties to errors.
        error.type = response[1];
        error.stack = response[3];

        this._onProcessEnd(error, null);
        break;
      default:
        throw new TypeError('Unexpected response from worker: ' + response[0]);
    }
  }

  onExit(exitCode: number) {
    if (exitCode !== 0) {
      this.initialize();
    }
  }

  send(request: ChildMessage, onProcessStart: OnStart, onProcessEnd: OnEnd) {
    onProcessStart(this);
    this._onProcessEnd = onProcessEnd;

    this._retries = 0;

    this._worker.postMessage(request);
  }

  getWorkerId(): number {
    return this._options.workerId;
  }

  getStdout(): NodeJS.ReadableStream {
    return this._worker.stdout;
  }

  getStderr(): NodeJS.ReadableStream {
    return this._worker.stderr;
  }
}
