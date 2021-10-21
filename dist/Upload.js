import { put } from 'axios';
import { Promise as Promise$1 } from 'es6-promise';
import SparkMD5 from 'spark-md5';
import debug$1 from 'debug';
import ExtendableError from 'es6-error';

const STORAGE_KEY = '__gcsBrowserUpload';

class FileMeta {
  constructor (id, fileSize, chunkSize, storage) {
    this.id = id;
    this.fileSize = fileSize;
    this.chunkSize = chunkSize;
    this.storage = storage;
  }

  getMeta () {
    const meta = this.storage.getItem(`${STORAGE_KEY}.${this.id}`);
    if (meta) {
      return JSON.parse(meta)
    } else {
      return {
        checksums: [],
        chunkSize: this.chunkSize,
        started: false,
        fileSize: this.fileSize
      }
    }
  }

  setMeta (meta) {
    const key = `${STORAGE_KEY}.${this.id}`;
    if (meta) {
      this.storage.setItem(key, JSON.stringify(meta));
    } else {
      this.storage.removeItem(key);
    }
  }

  isResumable () {
    let meta = this.getMeta();
    return meta.started && this.chunkSize === meta.chunkSize
  }

  getResumeIndex () {
    return this.getMeta().checksums.length
  }

  getFileSize () {
    return this.getMeta().fileSize
  }

  addChecksum (index, checksum) {
    let meta = this.getMeta();
    meta.checksums[index] = checksum;
    meta.started = true;
    this.setMeta(meta);
  }

  getChecksum (index) {
    return this.getMeta().checksums[index]
  }

  reset () {
    this.setMeta(null);
  }
}

var debug = debug$1('gcs-browser-upload');

class FileProcessor {
  constructor (file, chunkSize) {
    this.paused = false;
    this.file = file;
    this.chunkSize = chunkSize;
    this.unpauseHandlers = [];
  }

  async run (fn, startIndex = 0, endIndex) {
    const { file, chunkSize } = this;
    const totalChunks = Math.ceil(file.size / chunkSize);
    let spark = new SparkMD5.ArrayBuffer();

    debug('Starting run on file:');
    debug(` - Total chunks: ${totalChunks}`);
    debug(` - Start index: ${startIndex}`);
    debug(` - End index: ${endIndex || totalChunks}`);

    const processIndex = async (index) => {
      if (index === totalChunks || index === endIndex) {
        debug('File process complete');
        return true
      }
      if (this.paused) {
        await waitForUnpause();
      }

      const start = index * chunkSize;
      const section = file.slice(start, start + chunkSize);
      const chunk = await getData(file, section);
      const checksum = getChecksum(spark, chunk);

      const shouldContinue = await fn(checksum, index, chunk);
      if (shouldContinue !== false) {
        return processIndex(index + 1)
      }
      return false
    };

    const waitForUnpause = () => {
      return new Promise$1((resolve) => {
        this.unpauseHandlers.push(resolve);
      })
    };

    await processIndex(startIndex);
  }

  pause () {
    this.paused = true;
  }

  unpause () {
    this.paused = false;
    this.unpauseHandlers.forEach((fn) => fn());
    this.unpauseHandlers = [];
  }
}

function getChecksum (spark, chunk) {
  spark.append(chunk);
  const state = spark.getState();
  const checksum = spark.end();
  spark.setState(state);
  return checksum
}

async function getData (file, blob) {
  return new Promise$1((resolve, reject) => {
    let reader = new window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  })
}

class DifferentChunkError extends ExtendableError {
  constructor (chunkIndex, originalChecksum, newChecksum) {
    super(`Chunk at index '${chunkIndex}' is different to original`);
    this.chunkIndex = chunkIndex;
    this.originalChecksum = originalChecksum;
    this.newChecksum = newChecksum;
  }
}

class FileAlreadyUploadedError extends ExtendableError {
  constructor (id, url) {
    super(`File '${id}' has already been uploaded to unique url '${url}'`);
  }
}

class UrlNotFoundError extends ExtendableError {
  constructor (url) {
    super(`Upload URL '${url}' has either expired or is invalid`);
  }
}

class UploadFailedError extends ExtendableError {
  constructor (status) {
    super(`HTTP status ${status} received from GCS, consider retrying`);
  }
}

class UnknownResponseError extends ExtendableError {
  constructor (res) {
    super('Unknown response received from GCS');
    this.res = res;
  }
}

class MissingOptionsError extends ExtendableError {
  constructor () {
    super('Missing options for Upload');
  }
}

class UploadIncompleteError extends ExtendableError {
  constructor () {
    super('Upload is not complete');
  }
}

class InvalidChunkSizeError extends ExtendableError {
  constructor (chunkSize) {
    super(`Invalid chunk size ${chunkSize}, must be a multiple of 262144`);
  }
}

class UploadAlreadyFinishedError extends ExtendableError {
  constructor () {
    super('Upload instance has already finished');
  }
}

var errors = /*#__PURE__*/Object.freeze({
  __proto__: null,
  DifferentChunkError: DifferentChunkError,
  FileAlreadyUploadedError: FileAlreadyUploadedError,
  UrlNotFoundError: UrlNotFoundError,
  UploadFailedError: UploadFailedError,
  UnknownResponseError: UnknownResponseError,
  MissingOptionsError: MissingOptionsError,
  UploadIncompleteError: UploadIncompleteError,
  InvalidChunkSizeError: InvalidChunkSizeError,
  UploadAlreadyFinishedError: UploadAlreadyFinishedError
});

const MIN_CHUNK_SIZE = 262144;

class Upload {
  static errors = errors;

  constructor (args, allowSmallChunks) {
    var opts = {
      chunkSize: MIN_CHUNK_SIZE,
      storage: window.localStorage,
      contentType: 'text/plain',
      onChunkUpload: () => {},
      id: null,
      url: null,
      file: null,
      ...args
    };

    if ((opts.chunkSize % MIN_CHUNK_SIZE !== 0 || opts.chunkSize === 0) && !allowSmallChunks) {
      throw new InvalidChunkSizeError(opts.chunkSize)
    }

    if (!opts.id || !opts.url || !opts.file) {
      throw new MissingOptionsError()
    }

    debug('Creating new upload instance:');
    debug(` - Url: ${opts.url}`);
    debug(` - Id: ${opts.id}`);
    debug(` - File size: ${opts.file.size}`);
    debug(` - Chunk size: ${opts.chunkSize}`);

    this.opts = opts;
    this.meta = new FileMeta(opts.id, opts.file.size, opts.chunkSize, opts.storage);
    this.processor = new FileProcessor(opts.file, opts.chunkSize);
    this.lastResult = null;
  }

  async start () {
    const { meta, processor, opts, finished } = this;

    const resumeUpload = async () => {
      const localResumeIndex = meta.getResumeIndex();
      const remoteResumeIndex = await getRemoteResumeIndex();

      const resumeIndex = Math.min(localResumeIndex, remoteResumeIndex);
      debug(`Validating chunks up to index ${resumeIndex}`);
      debug(` - Remote index: ${remoteResumeIndex}`);
      debug(` - Local index: ${localResumeIndex}`);

      try {
        await processor.run(validateChunk, 0, resumeIndex);
      } catch (e) {
        debug('Validation failed, starting from scratch');
        debug(` - Failed chunk index: ${e.chunkIndex}`);
        debug(` - Old checksum: ${e.originalChecksum}`);
        debug(` - New checksum: ${e.newChecksum}`);

        await processor.run(uploadChunk);
        return
      }

      debug('Validation passed, resuming upload');
      await processor.run(uploadChunk, resumeIndex);
    };

    const uploadChunk = async (checksum, index, chunk) => {
      const total = opts.file.size;
      const start = index * opts.chunkSize;
      const end = index * opts.chunkSize + chunk.byteLength - 1;

      const headers = {
        'Content-Type': opts.contentType,
        'Content-Range': `bytes ${start}-${end}/${total}`
      };

      debug(`Uploading chunk ${index}:`);
      debug(` - Chunk length: ${chunk.byteLength}`);
      debug(` - Start: ${start}`);
      debug(` - End: ${end}`);

      const res = await safePut(opts.url, chunk, { headers });
      this.lastResult = res;
      checkResponseStatus(res, opts, [200, 201, 308]);
      debug(`Chunk upload succeeded, adding checksum ${checksum}`);
      meta.addChecksum(index, checksum);

      opts.onChunkUpload({
        totalBytes: total,
        uploadedBytes: end + 1,
        chunkIndex: index,
        chunkLength: chunk.byteLength
      });
    };

    const validateChunk = async (newChecksum, index) => {
      const originalChecksum = meta.getChecksum(index);
      const isChunkValid = originalChecksum === newChecksum;
      if (!isChunkValid) {
        meta.reset();
        throw new DifferentChunkError(index, originalChecksum, newChecksum)
      }
    };

    const getRemoteResumeIndex = async () => {
      const headers = {
        'Content-Range': `bytes */${opts.file.size}`
      };
      debug('Retrieving upload status from GCS');
      const res = await safePut(opts.url, null, { headers });

      checkResponseStatus(res, opts, [308]);
      const header = res.headers['range'];
      debug(`Received upload status from GCS: ${header}`);
      const range = header.match(/(\d+?)-(\d+?)$/);
      const bytesReceived = parseInt(range[2]) + 1;
      return Math.floor(bytesReceived / opts.chunkSize)
    };

    if (finished) {
      throw new UploadAlreadyFinishedError()
    }

    if (meta.isResumable() && meta.getFileSize() === opts.file.size) {
      debug('Upload might be resumable');
      await resumeUpload();
    } else {
      debug('Upload not resumable, starting from scratch');
      await processor.run(uploadChunk);
    }
    debug('Upload complete, resetting meta');
    meta.reset();
    this.finished = true;
    return this.lastResult
  }

  pause () {
    this.processor.pause();
    debug('Upload paused');
  }

  unpause () {
    this.processor.unpause();
    debug('Upload unpaused');
  }

  cancel () {
    this.processor.pause();
    this.meta.reset();
    debug('Upload cancelled');
  }
}

function checkResponseStatus (res, opts, allowed = []) {
  const { status } = res;
  if (allowed.indexOf(status) > -1) {
    return true
  }

  switch (status) {
    case 308:
      throw new UploadIncompleteError()

    case 201:
    case 200:
      throw new FileAlreadyUploadedError(opts.id, opts.url)

    case 404:
      throw new UrlNotFoundError(opts.url)

    case 500:
    case 502:
    case 503:
    case 504:
      throw new UploadFailedError(status)

    default:
      throw new UnknownResponseError(res)
  }
}

async function safePut () {
  try {
    return await put.apply(null, arguments)
  } catch (e) {
    if (e instanceof Error) {
      throw e
    } else {
      return e
    }
  }
}

export { Upload as default };
