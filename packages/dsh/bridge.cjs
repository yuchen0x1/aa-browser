#!/usr/bin/env node
globalThis.__AA_BRIDGE_VERSION__ = "0.14.0";
// \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod, mod.exports), cb = null), mod.exports);
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
let node_fs = require("node:fs");
node_fs = __toESM(node_fs, 1);
let node_os = require("node:os");
node_os = __toESM(node_os, 1);
let node_path = require("node:path");
node_path = __toESM(node_path, 1);
let node_process = require("node:process");
node_process = __toESM(node_process, 1);
let node_crypto = require("node:crypto");
let node_child_process = require("node:child_process");
let node_url = require("node:url");
// node_modules/ws/lib/constants.js
var require_constants = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const BINARY_TYPES = [
		"nodebuffer",
		"arraybuffer",
		"fragments"
	];
	const hasBlob = typeof Blob !== "undefined";
	if (hasBlob) BINARY_TYPES.push("blob");
	module.exports = {
		BINARY_TYPES,
		CLOSE_TIMEOUT: 3e4,
		EMPTY_BUFFER: Buffer.alloc(0),
		GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
		hasBlob,
		kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
		kListener: Symbol("kListener"),
		kStatusCode: Symbol("status-code"),
		kWebSocket: Symbol("websocket"),
		NOOP: () => {}
	};
}));
// node_modules/ws/lib/buffer-util.js
var require_buffer_util = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { websocketMask, websocketUnmask } = require("http");
	const { EMPTY_BUFFER } = require_constants();
	const FastBuffer = Buffer[Symbol.species];
	/**
	* Merges an array of buffers into a new buffer.
	*
	* @param {Buffer[]} list The array of buffers to concat
	* @param {Number} totalLength The total length of buffers in the list
	* @return {Buffer} The resulting buffer
	* @public
	*/
	function concat(list, totalLength) {
		if (list.length === 0) return EMPTY_BUFFER;
		if (list.length === 1) return list[0];
		const target = Buffer.allocUnsafe(totalLength);
		let offset = 0;
		for (let i = 0; i < list.length; i++) {
			const buf = list[i];
			target.set(buf, offset);
			offset += buf.length;
		}
		if (offset < totalLength) return new FastBuffer(target.buffer, target.byteOffset, offset);
		return target;
	}
	/**
	* Masks a buffer using the given mask.
	*
	* @param {Buffer} source The buffer to mask
	* @param {Buffer} mask The mask to use
	* @param {Buffer} output The buffer where to store the result
	* @param {Number} offset The offset at which to start writing
	* @param {Number} length The number of bytes to mask.
	* @public
	*/
	function _mask(source, mask, output, offset, length) {
		for (let i = 0; i < length; i++) output[offset + i] = source[i] ^ mask[i & 3];
	}
	/**
	* Unmasks a buffer using the given mask.
	*
	* @param {Buffer} buffer The buffer to unmask
	* @param {Buffer} mask The mask to use
	* @public
	*/
	function _unmask(buffer, mask) {
		for (let i = 0; i < buffer.length; i++) buffer[i] ^= mask[i & 3];
	}
	/**
	* Converts a buffer to an `ArrayBuffer`.
	*
	* @param {Buffer} buf The buffer to convert
	* @return {ArrayBuffer} Converted buffer
	* @public
	*/
	function toArrayBuffer(buf) {
		if (buf.length === buf.buffer.byteLength) return buf.buffer;
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
	}
	/**
	* Converts `data` to a `Buffer`.
	*
	* @param {*} data The data to convert
	* @return {Buffer} The buffer
	* @throws {TypeError}
	* @public
	*/
	function toBuffer(data) {
		toBuffer.readOnly = true;
		if (Buffer.isBuffer(data)) return data;
		let buf;
		if (data instanceof ArrayBuffer) buf = new FastBuffer(data);
		else if (ArrayBuffer.isView(data)) buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
		else {
			buf = Buffer.from(data);
			toBuffer.readOnly = false;
		}
		return buf;
	}
	module.exports = {
		concat,
		mask: _mask,
		toArrayBuffer,
		toBuffer,
		unmask: _unmask
	};
	if (websocketMask) {
		module.exports.mask = function(source, mask, output, offset, length) {
			if (length < 24) _mask(source, mask, output, offset, length);
			else websocketMask(source, mask, output, offset, length);
		};
		module.exports.unmask = function(buffer, mask) {
			if (buffer.length < 24) _unmask(buffer, mask);
			else websocketUnmask(buffer, mask);
		};
	} else if (!process.env.WS_NO_BUFFER_UTIL) try {
		const bufferUtil = require("bufferutil");
		module.exports.mask = function(source, mask, output, offset, length) {
			if (length < 48) _mask(source, mask, output, offset, length);
			else bufferUtil.mask(source, mask, output, offset, length);
		};
		module.exports.unmask = function(buffer, mask) {
			if (buffer.length < 32) _unmask(buffer, mask);
			else bufferUtil.unmask(buffer, mask);
		};
	} catch (e) {}
}));
// node_modules/ws/lib/limiter.js
var require_limiter = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const kDone = Symbol("kDone");
	const kRun = Symbol("kRun");
	/**
	* A very simple job queue with adjustable concurrency. Adapted from
	* https://github.com/STRML/async-limiter
	*/
	var Limiter = class {
		/**
		* Creates a new `Limiter`.
		*
		* @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
		*     to run concurrently
		*/
		constructor(concurrency) {
			this[kDone] = () => {
				this.pending--;
				this[kRun]();
			};
			this.concurrency = concurrency || Infinity;
			this.jobs = [];
			this.pending = 0;
		}
		/**
		* Adds a job to the queue.
		*
		* @param {Function} job The job to run
		* @public
		*/
		add(job) {
			this.jobs.push(job);
			this[kRun]();
		}
		/**
		* Removes a job from the queue and runs it if possible.
		*
		* @private
		*/
		[kRun]() {
			if (this.pending === this.concurrency) return;
			if (this.jobs.length) {
				const job = this.jobs.shift();
				this.pending++;
				job(this[kDone]);
			}
		}
	};
	module.exports = Limiter;
}));
// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const zlib = require("zlib");
	const bufferUtil = require_buffer_util();
	const Limiter = require_limiter();
	const { kStatusCode } = require_constants();
	const FastBuffer = Buffer[Symbol.species];
	const TRAILER = Buffer.from([
		0,
		0,
		255,
		255
	]);
	const kPerMessageDeflate = Symbol("permessage-deflate");
	const kTotalLength = Symbol("total-length");
	const kCallback = Symbol("callback");
	const kBuffers = Symbol("buffers");
	const kError = Symbol("error");
	let zlibLimiter;
	/**
	* permessage-deflate implementation.
	*/
	var PerMessageDeflate = class {
		/**
		* Creates a PerMessageDeflate instance.
		*
		* @param {Object} [options] Configuration options
		* @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
		*     for, or request, a custom client window size
		* @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
		*     acknowledge disabling of client context takeover
		* @param {Number} [options.concurrencyLimit=10] The number of concurrent
		*     calls to zlib
		* @param {Boolean} [options.isServer=false] Create the instance in either
		*     server or client mode
		* @param {Number} [options.maxPayload=0] The maximum allowed message length
		* @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
		*     use of a custom server window size
		* @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
		*     disabling of server context takeover
		* @param {Number} [options.threshold=1024] Size (in bytes) below which
		*     messages should not be compressed if context takeover is disabled
		* @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
		*     deflate
		* @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
		*     inflate
		*/
		constructor(options) {
			this._options = options || {};
			this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
			this._maxPayload = this._options.maxPayload | 0;
			this._isServer = !!this._options.isServer;
			this._deflate = null;
			this._inflate = null;
			this.params = null;
			if (!zlibLimiter) {
				const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
				zlibLimiter = new Limiter(concurrency);
			}
		}
		/**
		* @type {String}
		*/
		static get extensionName() {
			return "permessage-deflate";
		}
		/**
		* Create an extension negotiation offer.
		*
		* @return {Object} Extension parameters
		* @public
		*/
		offer() {
			const params = {};
			if (this._options.serverNoContextTakeover) params.server_no_context_takeover = true;
			if (this._options.clientNoContextTakeover) params.client_no_context_takeover = true;
			if (this._options.serverMaxWindowBits) params.server_max_window_bits = this._options.serverMaxWindowBits;
			if (this._options.clientMaxWindowBits) params.client_max_window_bits = this._options.clientMaxWindowBits;
			else if (this._options.clientMaxWindowBits == null) params.client_max_window_bits = true;
			return params;
		}
		/**
		* Accept an extension negotiation offer/response.
		*
		* @param {Array} configurations The extension negotiation offers/reponse
		* @return {Object} Accepted configuration
		* @public
		*/
		accept(configurations) {
			configurations = this.normalizeParams(configurations);
			this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
			return this.params;
		}
		/**
		* Releases all resources used by the extension.
		*
		* @public
		*/
		cleanup() {
			if (this._inflate) {
				this._inflate.close();
				this._inflate = null;
			}
			if (this._deflate) {
				const callback = this._deflate[kCallback];
				this._deflate.close();
				this._deflate = null;
				if (callback) callback(/* @__PURE__ */ new Error("The deflate stream was closed while data was being processed"));
			}
		}
		/**
		*  Accept an extension negotiation offer.
		*
		* @param {Array} offers The extension negotiation offers
		* @return {Object} Accepted configuration
		* @private
		*/
		acceptAsServer(offers) {
			const opts = this._options;
			const accepted = offers.find((params) => {
				if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params.client_max_window_bits : !params.client_max_window_bits)) return false;
				return true;
			});
			if (!accepted) throw new Error("None of the extension offers can be accepted");
			if (opts.serverNoContextTakeover) accepted.server_no_context_takeover = true;
			if (opts.clientNoContextTakeover) accepted.client_no_context_takeover = true;
			if (typeof opts.serverMaxWindowBits === "number") accepted.server_max_window_bits = opts.serverMaxWindowBits;
			if (typeof opts.clientMaxWindowBits === "number") accepted.client_max_window_bits = opts.clientMaxWindowBits;
			else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) delete accepted.client_max_window_bits;
			return accepted;
		}
		/**
		* Accept the extension negotiation response.
		*
		* @param {Array} response The extension negotiation response
		* @return {Object} Accepted configuration
		* @private
		*/
		acceptAsClient(response) {
			const params = response[0];
			if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) throw new Error("Unexpected parameter \"client_no_context_takeover\"");
			if (!params.client_max_window_bits) {
				if (typeof this._options.clientMaxWindowBits === "number") params.client_max_window_bits = this._options.clientMaxWindowBits;
			} else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) throw new Error("Unexpected or invalid parameter \"client_max_window_bits\"");
			return params;
		}
		/**
		* Normalize parameters.
		*
		* @param {Array} configurations The extension negotiation offers/reponse
		* @return {Array} The offers/response with normalized parameters
		* @private
		*/
		normalizeParams(configurations) {
			configurations.forEach((params) => {
				Object.keys(params).forEach((key) => {
					let value = params[key];
					if (value.length > 1) throw new Error(`Parameter "${key}" must have only a single value`);
					value = value[0];
					if (key === "client_max_window_bits") {
						if (value !== true) {
							const num = +value;
							if (!Number.isInteger(num) || num < 8 || num > 15) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
							value = num;
						} else if (!this._isServer) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
					} else if (key === "server_max_window_bits") {
						const num = +value;
						if (!Number.isInteger(num) || num < 8 || num > 15) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
						value = num;
					} else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
						if (value !== true) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
					} else throw new Error(`Unknown parameter "${key}"`);
					params[key] = value;
				});
			});
			return configurations;
		}
		/**
		* Decompress data. Concurrency limited.
		*
		* @param {Buffer} data Compressed data
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @public
		*/
		decompress(data, fin, callback) {
			zlibLimiter.add((done) => {
				this._decompress(data, fin, (err, result) => {
					done();
					callback(err, result);
				});
			});
		}
		/**
		* Compress data. Concurrency limited.
		*
		* @param {(Buffer|String)} data Data to compress
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @public
		*/
		compress(data, fin, callback) {
			zlibLimiter.add((done) => {
				this._compress(data, fin, (err, result) => {
					done();
					callback(err, result);
				});
			});
		}
		/**
		* Decompress data.
		*
		* @param {Buffer} data Compressed data
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @private
		*/
		_decompress(data, fin, callback) {
			const endpoint = this._isServer ? "client" : "server";
			if (!this._inflate) {
				const key = `${endpoint}_max_window_bits`;
				const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
				this._inflate = zlib.createInflateRaw({
					...this._options.zlibInflateOptions,
					windowBits
				});
				this._inflate[kPerMessageDeflate] = this;
				this._inflate[kTotalLength] = 0;
				this._inflate[kBuffers] = [];
				this._inflate.on("error", inflateOnError);
				this._inflate.on("data", inflateOnData);
			}
			this._inflate[kCallback] = callback;
			this._inflate.write(data);
			if (fin) this._inflate.write(TRAILER);
			this._inflate.flush(() => {
				const err = this._inflate[kError];
				if (err) {
					this._inflate.close();
					this._inflate = null;
					callback(err);
					return;
				}
				const data = bufferUtil.concat(this._inflate[kBuffers], this._inflate[kTotalLength]);
				if (this._inflate._readableState.endEmitted) {
					this._inflate.close();
					this._inflate = null;
				} else {
					this._inflate[kTotalLength] = 0;
					this._inflate[kBuffers] = [];
					if (fin && this.params[`${endpoint}_no_context_takeover`]) this._inflate.reset();
				}
				callback(null, data);
			});
		}
		/**
		* Compress data.
		*
		* @param {(Buffer|String)} data Data to compress
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @private
		*/
		_compress(data, fin, callback) {
			const endpoint = this._isServer ? "server" : "client";
			if (!this._deflate) {
				const key = `${endpoint}_max_window_bits`;
				const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
				this._deflate = zlib.createDeflateRaw({
					...this._options.zlibDeflateOptions,
					windowBits
				});
				this._deflate[kTotalLength] = 0;
				this._deflate[kBuffers] = [];
				this._deflate.on("data", deflateOnData);
			}
			this._deflate[kCallback] = callback;
			this._deflate.write(data);
			this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
				if (!this._deflate) return;
				let data = bufferUtil.concat(this._deflate[kBuffers], this._deflate[kTotalLength]);
				if (fin) data = new FastBuffer(data.buffer, data.byteOffset, data.length - 4);
				this._deflate[kCallback] = null;
				this._deflate[kTotalLength] = 0;
				this._deflate[kBuffers] = [];
				if (fin && this.params[`${endpoint}_no_context_takeover`]) this._deflate.reset();
				callback(null, data);
			});
		}
	};
	module.exports = PerMessageDeflate;
	/**
	* The listener of the `zlib.DeflateRaw` stream `'data'` event.
	*
	* @param {Buffer} chunk A chunk of data
	* @private
	*/
	function deflateOnData(chunk) {
		this[kBuffers].push(chunk);
		this[kTotalLength] += chunk.length;
	}
	/**
	* The listener of the `zlib.InflateRaw` stream `'data'` event.
	*
	* @param {Buffer} chunk A chunk of data
	* @private
	*/
	function inflateOnData(chunk) {
		this[kTotalLength] += chunk.length;
		if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
			this[kBuffers].push(chunk);
			return;
		}
		this[kError] = /* @__PURE__ */ new RangeError("Max payload size exceeded");
		this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
		this[kError][kStatusCode] = 1009;
		this.removeListener("data", inflateOnData);
		this.reset();
	}
	/**
	* The listener of the `zlib.InflateRaw` stream `'error'` event.
	*
	* @param {Error} err The emitted error
	* @private
	*/
	function inflateOnError(err) {
		this[kPerMessageDeflate]._inflate = null;
		if (this[kError]) {
			this[kCallback](this[kError]);
			return;
		}
		err[kStatusCode] = 1007;
		this[kCallback](err);
	}
}));
// node_modules/ws/lib/validation.js
var require_validation = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { isUtf8 } = require("buffer");
	const { hasBlob } = require_constants();
	const tokenChars = [
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		1,
		0,
		1,
		1,
		1,
		1,
		1,
		0,
		0,
		1,
		1,
		0,
		1,
		1,
		0,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		0,
		0,
		0,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		0,
		1,
		0,
		1,
		0
	];
	/**
	* Checks if a status code is allowed in a close frame.
	*
	* @param {Number} code The status code
	* @return {Boolean} `true` if the status code is valid, else `false`
	* @public
	*/
	function isValidStatusCode(code) {
		return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
	}
	/**
	* Checks if a given buffer contains only correct UTF-8.
	* Ported from https://www.cl.cam.ac.uk/%7Emgk25/ucs/utf8_check.c by
	* Markus Kuhn.
	*
	* @param {Buffer} buf The buffer to check
	* @return {Boolean} `true` if `buf` contains only correct UTF-8, else `false`
	* @public
	*/
	function _isValidUTF8(buf) {
		const len = buf.length;
		let i = 0;
		while (i < len) if ((buf[i] & 128) === 0) i++;
		else if ((buf[i] & 224) === 192) {
			if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) return false;
			i += 2;
		} else if ((buf[i] & 240) === 224) {
			if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || buf[i] === 237 && (buf[i + 1] & 224) === 160) return false;
			i += 3;
		} else if ((buf[i] & 248) === 240) {
			if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) return false;
			i += 4;
		} else return false;
		return true;
	}
	/**
	* Determines whether a value is a `Blob`.
	*
	* @param {*} value The value to be tested
	* @return {Boolean} `true` if `value` is a `Blob`, else `false`
	* @private
	*/
	function isBlob(value) {
		return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
	}
	module.exports = {
		isBlob,
		isValidStatusCode,
		isValidUTF8: _isValidUTF8,
		tokenChars
	};
	if (isUtf8) module.exports.isValidUTF8 = function(buf) {
		return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
	};
	else if (!process.env.WS_NO_UTF_8_VALIDATE) try {
		const isValidUTF8 = require("utf-8-validate");
		module.exports.isValidUTF8 = function(buf) {
			return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
		};
	} catch (e) {}
}));
// node_modules/ws/lib/receiver.js
var require_receiver = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { Writable } = require("stream");
	const PerMessageDeflate = require_permessage_deflate();
	const { BINARY_TYPES, EMPTY_BUFFER, kStatusCode, kWebSocket } = require_constants();
	const { concat, toArrayBuffer, unmask } = require_buffer_util();
	const { isValidStatusCode, isValidUTF8 } = require_validation();
	const FastBuffer = Buffer[Symbol.species];
	const GET_INFO = 0;
	const GET_PAYLOAD_LENGTH_16 = 1;
	const GET_PAYLOAD_LENGTH_64 = 2;
	const GET_MASK = 3;
	const GET_DATA = 4;
	const INFLATING = 5;
	const DEFER_EVENT = 6;
	/**
	* HyBi Receiver implementation.
	*
	* @extends Writable
	*/
	var Receiver = class extends Writable {
		/**
		* Creates a Receiver instance.
		*
		* @param {Object} [options] Options object
		* @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
		*     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
		*     multiple times in the same tick
		* @param {String} [options.binaryType=nodebuffer] The type for binary data
		* @param {Object} [options.extensions] An object containing the negotiated
		*     extensions
		* @param {Boolean} [options.isServer=false] Specifies whether to operate in
		*     client or server mode
		* @param {Number} [options.maxBufferedChunks=0] The maximum number of
		*     buffered data chunks
		* @param {Number} [options.maxFragments=0] The maximum number of message
		*     fragments
		* @param {Number} [options.maxPayload=0] The maximum allowed message length
		* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
		*     not to skip UTF-8 validation for text and close messages
		*/
		constructor(options = {}) {
			super();
			this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
			this._binaryType = options.binaryType || BINARY_TYPES[0];
			this._extensions = options.extensions || {};
			this._isServer = !!options.isServer;
			this._maxBufferedChunks = options.maxBufferedChunks | 0;
			this._maxFragments = options.maxFragments | 0;
			this._maxPayload = options.maxPayload | 0;
			this._skipUTF8Validation = !!options.skipUTF8Validation;
			this[kWebSocket] = void 0;
			this._bufferedBytes = 0;
			this._buffers = [];
			this._compressed = false;
			this._payloadLength = 0;
			this._mask = void 0;
			this._fragmented = 0;
			this._masked = false;
			this._fin = false;
			this._opcode = 0;
			this._totalPayloadLength = 0;
			this._messageLength = 0;
			this._numFragments = 0;
			this._fragments = [];
			this._errored = false;
			this._loop = false;
			this._state = GET_INFO;
		}
		/**
		* Implements `Writable.prototype._write()`.
		*
		* @param {Buffer} chunk The chunk of data to write
		* @param {String} encoding The character encoding of `chunk`
		* @param {Function} cb Callback
		* @private
		*/
		_write(chunk, encoding, cb) {
			if (this._opcode === 8 && this._state == GET_INFO) return cb();
			if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
				cb(this.createError(RangeError, "Too many buffered chunks", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
				return;
			}
			this._bufferedBytes += chunk.length;
			this._buffers.push(chunk);
			this.startLoop(cb);
		}
		/**
		* Consumes `n` bytes from the buffered data.
		*
		* @param {Number} n The number of bytes to consume
		* @return {Buffer} The consumed bytes
		* @private
		*/
		consume(n) {
			this._bufferedBytes -= n;
			if (n === this._buffers[0].length) return this._buffers.shift();
			if (n < this._buffers[0].length) {
				const buf = this._buffers[0];
				this._buffers[0] = new FastBuffer(buf.buffer, buf.byteOffset + n, buf.length - n);
				return new FastBuffer(buf.buffer, buf.byteOffset, n);
			}
			const dst = Buffer.allocUnsafe(n);
			do {
				const buf = this._buffers[0];
				const offset = dst.length - n;
				if (n >= buf.length) dst.set(this._buffers.shift(), offset);
				else {
					dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
					this._buffers[0] = new FastBuffer(buf.buffer, buf.byteOffset + n, buf.length - n);
				}
				n -= buf.length;
			} while (n > 0);
			return dst;
		}
		/**
		* Starts the parsing loop.
		*
		* @param {Function} cb Callback
		* @private
		*/
		startLoop(cb) {
			this._loop = true;
			do
				switch (this._state) {
					case GET_INFO:
						this.getInfo(cb);
						break;
					case GET_PAYLOAD_LENGTH_16:
						this.getPayloadLength16(cb);
						break;
					case GET_PAYLOAD_LENGTH_64:
						this.getPayloadLength64(cb);
						break;
					case GET_MASK:
						this.getMask();
						break;
					case GET_DATA:
						this.getData(cb);
						break;
					case INFLATING:
					case DEFER_EVENT:
						this._loop = false;
						return;
				}
			while (this._loop);
			if (!this._errored) cb();
		}
		/**
		* Reads the first two bytes of a frame.
		*
		* @param {Function} cb Callback
		* @private
		*/
		getInfo(cb) {
			if (this._bufferedBytes < 2) {
				this._loop = false;
				return;
			}
			const buf = this.consume(2);
			if ((buf[0] & 48) !== 0) {
				cb(this.createError(RangeError, "RSV2 and RSV3 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_2_3"));
				return;
			}
			const compressed = (buf[0] & 64) === 64;
			if (compressed && !this._extensions[PerMessageDeflate.extensionName]) {
				cb(this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1"));
				return;
			}
			this._fin = (buf[0] & 128) === 128;
			this._opcode = buf[0] & 15;
			this._payloadLength = buf[1] & 127;
			if (this._opcode === 0) {
				if (compressed) {
					cb(this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1"));
					return;
				}
				if (!this._fragmented) {
					cb(this.createError(RangeError, "invalid opcode 0", true, 1002, "WS_ERR_INVALID_OPCODE"));
					return;
				}
				this._opcode = this._fragmented;
			} else if (this._opcode === 1 || this._opcode === 2) {
				if (this._fragmented) {
					cb(this.createError(RangeError, `invalid opcode ${this._opcode}`, true, 1002, "WS_ERR_INVALID_OPCODE"));
					return;
				}
				this._compressed = compressed;
			} else if (this._opcode > 7 && this._opcode < 11) {
				if (!this._fin) {
					cb(this.createError(RangeError, "FIN must be set", true, 1002, "WS_ERR_EXPECTED_FIN"));
					return;
				}
				if (compressed) {
					cb(this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1"));
					return;
				}
				if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
					cb(this.createError(RangeError, `invalid payload length ${this._payloadLength}`, true, 1002, "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"));
					return;
				}
			} else {
				cb(this.createError(RangeError, `invalid opcode ${this._opcode}`, true, 1002, "WS_ERR_INVALID_OPCODE"));
				return;
			}
			if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
			this._masked = (buf[1] & 128) === 128;
			if (this._isServer) {
				if (!this._masked) {
					cb(this.createError(RangeError, "MASK must be set", true, 1002, "WS_ERR_EXPECTED_MASK"));
					return;
				}
			} else if (this._masked) {
				cb(this.createError(RangeError, "MASK must be clear", true, 1002, "WS_ERR_UNEXPECTED_MASK"));
				return;
			}
			if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
			else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
			else this.haveLength(cb);
		}
		/**
		* Gets extended payload length (7+16).
		*
		* @param {Function} cb Callback
		* @private
		*/
		getPayloadLength16(cb) {
			if (this._bufferedBytes < 2) {
				this._loop = false;
				return;
			}
			this._payloadLength = this.consume(2).readUInt16BE(0);
			this.haveLength(cb);
		}
		/**
		* Gets extended payload length (7+64).
		*
		* @param {Function} cb Callback
		* @private
		*/
		getPayloadLength64(cb) {
			if (this._bufferedBytes < 8) {
				this._loop = false;
				return;
			}
			const buf = this.consume(8);
			const num = buf.readUInt32BE(0);
			if (num > Math.pow(2, 21) - 1) {
				cb(this.createError(RangeError, "Unsupported WebSocket frame: payload length > 2^53 - 1", false, 1009, "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"));
				return;
			}
			this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
			this.haveLength(cb);
		}
		/**
		* Payload length has been read.
		*
		* @param {Function} cb Callback
		* @private
		*/
		haveLength(cb) {
			if (this._payloadLength && this._opcode < 8) {
				this._totalPayloadLength += this._payloadLength;
				if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
					cb(this.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
					return;
				}
			}
			if (this._masked) this._state = GET_MASK;
			else this._state = GET_DATA;
		}
		/**
		* Reads mask bytes.
		*
		* @private
		*/
		getMask() {
			if (this._bufferedBytes < 4) {
				this._loop = false;
				return;
			}
			this._mask = this.consume(4);
			this._state = GET_DATA;
		}
		/**
		* Reads data bytes.
		*
		* @param {Function} cb Callback
		* @private
		*/
		getData(cb) {
			let data = EMPTY_BUFFER;
			if (this._payloadLength) {
				if (this._bufferedBytes < this._payloadLength) {
					this._loop = false;
					return;
				}
				data = this.consume(this._payloadLength);
				if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) unmask(data, this._mask);
			}
			this._mask = void 0;
			if (this._opcode > 7) {
				this.controlMessage(data, cb);
				return;
			}
			if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
				cb(this.createError(RangeError, "Too many message fragments", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
				return;
			}
			if (this._compressed) {
				this._state = INFLATING;
				this.decompress(data, cb);
				return;
			}
			if (data.length) {
				this._messageLength = this._totalPayloadLength;
				this._fragments.push(data);
			}
			this.dataMessage(cb);
		}
		/**
		* Decompresses data.
		*
		* @param {Buffer} data Compressed data
		* @param {Function} cb Callback
		* @private
		*/
		decompress(data, cb) {
			this._extensions[PerMessageDeflate.extensionName].decompress(data, this._fin, (err, buf) => {
				if (err) return cb(err);
				if (buf.length) {
					this._messageLength += buf.length;
					if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
						cb(this.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
						return;
					}
					this._fragments.push(buf);
				}
				this.dataMessage(cb);
				if (this._state === GET_INFO) this.startLoop(cb);
			});
		}
		/**
		* Handles a data message.
		*
		* @param {Function} cb Callback
		* @private
		*/
		dataMessage(cb) {
			if (!this._fin) {
				this._state = GET_INFO;
				return;
			}
			const messageLength = this._messageLength;
			const fragments = this._fragments;
			this._totalPayloadLength = 0;
			this._messageLength = 0;
			this._fragmented = 0;
			this._numFragments = 0;
			this._fragments = [];
			if (this._opcode === 2) {
				let data;
				if (this._binaryType === "nodebuffer") data = concat(fragments, messageLength);
				else if (this._binaryType === "arraybuffer") data = toArrayBuffer(concat(fragments, messageLength));
				else if (this._binaryType === "blob") data = new Blob(fragments);
				else data = fragments;
				if (this._allowSynchronousEvents) {
					this.emit("message", data, true);
					this._state = GET_INFO;
				} else {
					this._state = DEFER_EVENT;
					setImmediate(() => {
						this.emit("message", data, true);
						this._state = GET_INFO;
						this.startLoop(cb);
					});
				}
			} else {
				const buf = concat(fragments, messageLength);
				if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
					cb(this.createError(Error, "invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8"));
					return;
				}
				if (this._state === INFLATING || this._allowSynchronousEvents) {
					this.emit("message", buf, false);
					this._state = GET_INFO;
				} else {
					this._state = DEFER_EVENT;
					setImmediate(() => {
						this.emit("message", buf, false);
						this._state = GET_INFO;
						this.startLoop(cb);
					});
				}
			}
		}
		/**
		* Handles a control message.
		*
		* @param {Buffer} data Data to handle
		* @return {(Error|RangeError|undefined)} A possible error
		* @private
		*/
		controlMessage(data, cb) {
			if (this._opcode === 8) {
				if (data.length === 0) {
					this._loop = false;
					this.emit("conclude", 1005, EMPTY_BUFFER);
					this.end();
				} else {
					const code = data.readUInt16BE(0);
					if (!isValidStatusCode(code)) {
						cb(this.createError(RangeError, `invalid status code ${code}`, true, 1002, "WS_ERR_INVALID_CLOSE_CODE"));
						return;
					}
					const buf = new FastBuffer(data.buffer, data.byteOffset + 2, data.length - 2);
					if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
						cb(this.createError(Error, "invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8"));
						return;
					}
					this._loop = false;
					this.emit("conclude", code, buf);
					this.end();
				}
				this._state = GET_INFO;
				return;
			}
			if (this._allowSynchronousEvents) {
				this.emit(this._opcode === 9 ? "ping" : "pong", data);
				this._state = GET_INFO;
			} else {
				this._state = DEFER_EVENT;
				setImmediate(() => {
					this.emit(this._opcode === 9 ? "ping" : "pong", data);
					this._state = GET_INFO;
					this.startLoop(cb);
				});
			}
		}
		/**
		* Builds an error object.
		*
		* @param {function(new:Error|RangeError)} ErrorCtor The error constructor
		* @param {String} message The error message
		* @param {Boolean} prefix Specifies whether or not to add a default prefix to
		*     `message`
		* @param {Number} statusCode The status code
		* @param {String} errorCode The exposed error code
		* @return {(Error|RangeError)} The error
		* @private
		*/
		createError(ErrorCtor, message, prefix, statusCode, errorCode) {
			this._loop = false;
			this._errored = true;
			const err = new ErrorCtor(prefix ? `Invalid WebSocket frame: ${message}` : message);
			Error.captureStackTrace(err, this.createError);
			err.code = errorCode;
			err[kStatusCode] = statusCode;
			return err;
		}
	};
	module.exports = Receiver;
}));
// node_modules/ws/lib/sender.js
var require_sender = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { Duplex } = require("stream");
	const { randomFillSync } = require("crypto");
	const { types: { isUint8Array } } = require("util");
	const PerMessageDeflate = require_permessage_deflate();
	const { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
	const { isBlob, isValidStatusCode } = require_validation();
	const { mask: applyMask, toBuffer } = require_buffer_util();
	const kByteLength = Symbol("kByteLength");
	const maskBuffer = Buffer.alloc(4);
	const RANDOM_POOL_SIZE = 8192;
	let randomPool;
	let randomPoolPointer = RANDOM_POOL_SIZE;
	const DEFAULT = 0;
	const DEFLATING = 1;
	const GET_BLOB_DATA = 2;
	module.exports = class Sender {
		/**
		* Creates a Sender instance.
		*
		* @param {Duplex} socket The connection socket
		* @param {Object} [extensions] An object containing the negotiated extensions
		* @param {Function} [generateMask] The function used to generate the masking
		*     key
		*/
		constructor(socket, extensions, generateMask) {
			this._extensions = extensions || {};
			if (generateMask) {
				this._generateMask = generateMask;
				this._maskBuffer = Buffer.alloc(4);
			}
			this._socket = socket;
			this._firstFragment = true;
			this._compress = false;
			this._bufferedBytes = 0;
			this._queue = [];
			this._state = DEFAULT;
			this.onerror = NOOP;
			this[kWebSocket] = void 0;
		}
		/**
		* Frames a piece of data according to the HyBi WebSocket protocol.
		*
		* @param {(Buffer|String)} data The data to frame
		* @param {Object} options Options object
		* @param {Boolean} [options.fin=false] Specifies whether or not to set the
		*     FIN bit
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Buffer} [options.maskBuffer] The buffer used to store the masking
		*     key
		* @param {Number} options.opcode The opcode
		* @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
		*     modified
		* @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
		*     RSV1 bit
		* @return {(Buffer|String)[]} The framed data
		* @public
		*/
		static frame(data, options) {
			let mask;
			let merge = false;
			let offset = 2;
			let skipMasking = false;
			if (options.mask) {
				mask = options.maskBuffer || maskBuffer;
				if (options.generateMask) options.generateMask(mask);
				else {
					if (randomPoolPointer === RANDOM_POOL_SIZE) {
						/* istanbul ignore else  */
						if (randomPool === void 0) randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
						randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
						randomPoolPointer = 0;
					}
					mask[0] = randomPool[randomPoolPointer++];
					mask[1] = randomPool[randomPoolPointer++];
					mask[2] = randomPool[randomPoolPointer++];
					mask[3] = randomPool[randomPoolPointer++];
				}
				skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
				offset = 6;
			}
			let dataLength;
			if (typeof data === "string") {
				if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) dataLength = options[kByteLength];
				else {
					data = Buffer.from(data);
					dataLength = data.length;
				}
			} else {
				dataLength = data.length;
				merge = options.mask && options.readOnly && !skipMasking;
			}
			let payloadLength = dataLength;
			if (dataLength >= 65536) {
				offset += 8;
				payloadLength = 127;
			} else if (dataLength > 125) {
				offset += 2;
				payloadLength = 126;
			}
			const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
			target[0] = options.fin ? options.opcode | 128 : options.opcode;
			if (options.rsv1) target[0] |= 64;
			target[1] = payloadLength;
			if (payloadLength === 126) target.writeUInt16BE(dataLength, 2);
			else if (payloadLength === 127) {
				target[2] = target[3] = 0;
				target.writeUIntBE(dataLength, 4, 6);
			}
			if (!options.mask) return dataLength ? [target, data] : [target];
			target[1] |= 128;
			target[offset - 4] = mask[0];
			target[offset - 3] = mask[1];
			target[offset - 2] = mask[2];
			target[offset - 1] = mask[3];
			if (!dataLength) return [target];
			if (skipMasking) return [target, data];
			if (merge) {
				applyMask(data, mask, target, offset, dataLength);
				return [target];
			}
			applyMask(data, mask, data, 0, dataLength);
			return [target, data];
		}
		/**
		* Sends a close message to the other peer.
		*
		* @param {Number} [code] The status code component of the body
		* @param {(String|Buffer)} [data] The message component of the body
		* @param {Boolean} [mask=false] Specifies whether or not to mask the message
		* @param {Function} [cb] Callback
		* @public
		*/
		close(code, data, mask, cb) {
			let buf;
			if (code === void 0) buf = EMPTY_BUFFER;
			else if (typeof code !== "number" || !isValidStatusCode(code)) throw new TypeError("First argument must be a valid error code number");
			else if (data === void 0 || !data.length) {
				buf = Buffer.allocUnsafe(2);
				buf.writeUInt16BE(code, 0);
			} else {
				const length = Buffer.byteLength(data);
				if (length > 123) throw new RangeError("The message must not be greater than 123 bytes");
				buf = Buffer.allocUnsafe(2 + length);
				buf.writeUInt16BE(code, 0);
				if (typeof data === "string") buf.write(data, 2);
				else if (isUint8Array(data)) buf.set(data, 2);
				else throw new TypeError("Second argument must be a string or a Uint8Array");
			}
			const options = {
				[kByteLength]: buf.length,
				fin: true,
				generateMask: this._generateMask,
				mask,
				maskBuffer: this._maskBuffer,
				opcode: 8,
				readOnly: false,
				rsv1: false
			};
			if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				buf,
				false,
				options,
				cb
			]);
			else this.sendFrame(Sender.frame(buf, options), cb);
		}
		/**
		* Sends a ping message to the other peer.
		*
		* @param {*} data The message to send
		* @param {Boolean} [mask=false] Specifies whether or not to mask `data`
		* @param {Function} [cb] Callback
		* @public
		*/
		ping(data, mask, cb) {
			let byteLength;
			let readOnly;
			if (typeof data === "string") {
				byteLength = Buffer.byteLength(data);
				readOnly = false;
			} else if (isBlob(data)) {
				byteLength = data.size;
				readOnly = false;
			} else {
				data = toBuffer(data);
				byteLength = data.length;
				readOnly = toBuffer.readOnly;
			}
			if (byteLength > 125) throw new RangeError("The data size must not be greater than 125 bytes");
			const options = {
				[kByteLength]: byteLength,
				fin: true,
				generateMask: this._generateMask,
				mask,
				maskBuffer: this._maskBuffer,
				opcode: 9,
				readOnly,
				rsv1: false
			};
			if (isBlob(data)) {
				if (this._state !== DEFAULT) this.enqueue([
					this.getBlobData,
					data,
					false,
					options,
					cb
				]);
				else this.getBlobData(data, false, options, cb);
			} else if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				data,
				false,
				options,
				cb
			]);
			else this.sendFrame(Sender.frame(data, options), cb);
		}
		/**
		* Sends a pong message to the other peer.
		*
		* @param {*} data The message to send
		* @param {Boolean} [mask=false] Specifies whether or not to mask `data`
		* @param {Function} [cb] Callback
		* @public
		*/
		pong(data, mask, cb) {
			let byteLength;
			let readOnly;
			if (typeof data === "string") {
				byteLength = Buffer.byteLength(data);
				readOnly = false;
			} else if (isBlob(data)) {
				byteLength = data.size;
				readOnly = false;
			} else {
				data = toBuffer(data);
				byteLength = data.length;
				readOnly = toBuffer.readOnly;
			}
			if (byteLength > 125) throw new RangeError("The data size must not be greater than 125 bytes");
			const options = {
				[kByteLength]: byteLength,
				fin: true,
				generateMask: this._generateMask,
				mask,
				maskBuffer: this._maskBuffer,
				opcode: 10,
				readOnly,
				rsv1: false
			};
			if (isBlob(data)) {
				if (this._state !== DEFAULT) this.enqueue([
					this.getBlobData,
					data,
					false,
					options,
					cb
				]);
				else this.getBlobData(data, false, options, cb);
			} else if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				data,
				false,
				options,
				cb
			]);
			else this.sendFrame(Sender.frame(data, options), cb);
		}
		/**
		* Sends a data message to the other peer.
		*
		* @param {*} data The message to send
		* @param {Object} options Options object
		* @param {Boolean} [options.binary=false] Specifies whether `data` is binary
		*     or text
		* @param {Boolean} [options.compress=false] Specifies whether or not to
		*     compress `data`
		* @param {Boolean} [options.fin=false] Specifies whether the fragment is the
		*     last one
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Function} [cb] Callback
		* @public
		*/
		send(data, options, cb) {
			const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
			let opcode = options.binary ? 2 : 1;
			let rsv1 = options.compress;
			let byteLength;
			let readOnly;
			if (typeof data === "string") {
				byteLength = Buffer.byteLength(data);
				readOnly = false;
			} else if (isBlob(data)) {
				byteLength = data.size;
				readOnly = false;
			} else {
				data = toBuffer(data);
				byteLength = data.length;
				readOnly = toBuffer.readOnly;
			}
			if (this._firstFragment) {
				this._firstFragment = false;
				if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) rsv1 = byteLength >= perMessageDeflate._threshold;
				this._compress = rsv1;
			} else {
				rsv1 = false;
				opcode = 0;
			}
			if (options.fin) this._firstFragment = true;
			const opts = {
				[kByteLength]: byteLength,
				fin: options.fin,
				generateMask: this._generateMask,
				mask: options.mask,
				maskBuffer: this._maskBuffer,
				opcode,
				readOnly,
				rsv1
			};
			if (isBlob(data)) {
				if (this._state !== DEFAULT) this.enqueue([
					this.getBlobData,
					data,
					this._compress,
					opts,
					cb
				]);
				else this.getBlobData(data, this._compress, opts, cb);
			} else if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				data,
				this._compress,
				opts,
				cb
			]);
			else this.dispatch(data, this._compress, opts, cb);
		}
		/**
		* Gets the contents of a blob as binary data.
		*
		* @param {Blob} blob The blob
		* @param {Boolean} [compress=false] Specifies whether or not to compress
		*     the data
		* @param {Object} options Options object
		* @param {Boolean} [options.fin=false] Specifies whether or not to set the
		*     FIN bit
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Buffer} [options.maskBuffer] The buffer used to store the masking
		*     key
		* @param {Number} options.opcode The opcode
		* @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
		*     modified
		* @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
		*     RSV1 bit
		* @param {Function} [cb] Callback
		* @private
		*/
		getBlobData(blob, compress, options, cb) {
			this._bufferedBytes += options[kByteLength];
			this._state = GET_BLOB_DATA;
			blob.arrayBuffer().then((arrayBuffer) => {
				if (this._socket.destroyed) {
					const err = /* @__PURE__ */ new Error("The socket was closed while the blob was being read");
					process.nextTick(callCallbacks, this, err, cb);
					return;
				}
				this._bufferedBytes -= options[kByteLength];
				const data = toBuffer(arrayBuffer);
				if (!compress) {
					this._state = DEFAULT;
					this.sendFrame(Sender.frame(data, options), cb);
					this.dequeue();
				} else this.dispatch(data, compress, options, cb);
			}).catch((err) => {
				process.nextTick(onError, this, err, cb);
			});
		}
		/**
		* Dispatches a message.
		*
		* @param {(Buffer|String)} data The message to send
		* @param {Boolean} [compress=false] Specifies whether or not to compress
		*     `data`
		* @param {Object} options Options object
		* @param {Boolean} [options.fin=false] Specifies whether or not to set the
		*     FIN bit
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Buffer} [options.maskBuffer] The buffer used to store the masking
		*     key
		* @param {Number} options.opcode The opcode
		* @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
		*     modified
		* @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
		*     RSV1 bit
		* @param {Function} [cb] Callback
		* @private
		*/
		dispatch(data, compress, options, cb) {
			if (!compress) {
				this.sendFrame(Sender.frame(data, options), cb);
				return;
			}
			const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
			this._bufferedBytes += options[kByteLength];
			this._state = DEFLATING;
			perMessageDeflate.compress(data, options.fin, (_, buf) => {
				if (this._socket.destroyed) {
					const err = /* @__PURE__ */ new Error("The socket was closed while data was being compressed");
					callCallbacks(this, err, cb);
					return;
				}
				this._bufferedBytes -= options[kByteLength];
				this._state = DEFAULT;
				options.readOnly = false;
				this.sendFrame(Sender.frame(buf, options), cb);
				this.dequeue();
			});
		}
		/**
		* Executes queued send operations.
		*
		* @private
		*/
		dequeue() {
			while (this._state === DEFAULT && this._queue.length) {
				const params = this._queue.shift();
				this._bufferedBytes -= params[3][kByteLength];
				Reflect.apply(params[0], this, params.slice(1));
			}
		}
		/**
		* Enqueues a send operation.
		*
		* @param {Array} params Send operation parameters.
		* @private
		*/
		enqueue(params) {
			this._bufferedBytes += params[3][kByteLength];
			this._queue.push(params);
		}
		/**
		* Sends a frame.
		*
		* @param {(Buffer | String)[]} list The frame to send
		* @param {Function} [cb] Callback
		* @private
		*/
		sendFrame(list, cb) {
			if (list.length === 2) {
				this._socket.cork();
				this._socket.write(list[0]);
				this._socket.write(list[1], cb);
				this._socket.uncork();
			} else this._socket.write(list[0], cb);
		}
	};
	/**
	* Calls queued callbacks with an error.
	*
	* @param {Sender} sender The `Sender` instance
	* @param {Error} err The error to call the callbacks with
	* @param {Function} [cb] The first callback
	* @private
	*/
	function callCallbacks(sender, err, cb) {
		if (typeof cb === "function") cb(err);
		for (let i = 0; i < sender._queue.length; i++) {
			const params = sender._queue[i];
			const callback = params[params.length - 1];
			if (typeof callback === "function") callback(err);
		}
	}
	/**
	* Handles a `Sender` error.
	*
	* @param {Sender} sender The `Sender` instance
	* @param {Error} err The error
	* @param {Function} [cb] The first pending callback
	* @private
	*/
	function onError(sender, err, cb) {
		callCallbacks(sender, err, cb);
		sender.onerror(err);
	}
}));
// node_modules/ws/lib/event-target.js
var require_event_target = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { kForOnEventAttribute, kListener } = require_constants();
	const kCode = Symbol("kCode");
	const kData = Symbol("kData");
	const kError = Symbol("kError");
	const kMessage = Symbol("kMessage");
	const kReason = Symbol("kReason");
	const kTarget = Symbol("kTarget");
	const kType = Symbol("kType");
	const kWasClean = Symbol("kWasClean");
	/**
	* Class representing an event.
	*/
	var Event = class {
		/**
		* Create a new `Event`.
		*
		* @param {String} type The name of the event
		* @throws {TypeError} If the `type` argument is not specified
		*/
		constructor(type) {
			this[kTarget] = null;
			this[kType] = type;
		}
		/**
		* @type {*}
		*/
		get target() {
			return this[kTarget];
		}
		/**
		* @type {String}
		*/
		get type() {
			return this[kType];
		}
	};
	Object.defineProperty(Event.prototype, "target", { enumerable: true });
	Object.defineProperty(Event.prototype, "type", { enumerable: true });
	/**
	* Class representing a close event.
	*
	* @extends Event
	*/
	var CloseEvent = class extends Event {
		/**
		* Create a new `CloseEvent`.
		*
		* @param {String} type The name of the event
		* @param {Object} [options] A dictionary object that allows for setting
		*     attributes via object members of the same name
		* @param {Number} [options.code=0] The status code explaining why the
		*     connection was closed
		* @param {String} [options.reason=''] A human-readable string explaining why
		*     the connection was closed
		* @param {Boolean} [options.wasClean=false] Indicates whether or not the
		*     connection was cleanly closed
		*/
		constructor(type, options = {}) {
			super(type);
			this[kCode] = options.code === void 0 ? 0 : options.code;
			this[kReason] = options.reason === void 0 ? "" : options.reason;
			this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
		}
		/**
		* @type {Number}
		*/
		get code() {
			return this[kCode];
		}
		/**
		* @type {String}
		*/
		get reason() {
			return this[kReason];
		}
		/**
		* @type {Boolean}
		*/
		get wasClean() {
			return this[kWasClean];
		}
	};
	Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
	Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
	Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
	/**
	* Class representing an error event.
	*
	* @extends Event
	*/
	var ErrorEvent = class extends Event {
		/**
		* Create a new `ErrorEvent`.
		*
		* @param {String} type The name of the event
		* @param {Object} [options] A dictionary object that allows for setting
		*     attributes via object members of the same name
		* @param {*} [options.error=null] The error that generated this event
		* @param {String} [options.message=''] The error message
		*/
		constructor(type, options = {}) {
			super(type);
			this[kError] = options.error === void 0 ? null : options.error;
			this[kMessage] = options.message === void 0 ? "" : options.message;
		}
		/**
		* @type {*}
		*/
		get error() {
			return this[kError];
		}
		/**
		* @type {String}
		*/
		get message() {
			return this[kMessage];
		}
	};
	Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
	Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
	/**
	* Class representing a message event.
	*
	* @extends Event
	*/
	var MessageEvent = class extends Event {
		/**
		* Create a new `MessageEvent`.
		*
		* @param {String} type The name of the event
		* @param {Object} [options] A dictionary object that allows for setting
		*     attributes via object members of the same name
		* @param {*} [options.data=null] The message content
		*/
		constructor(type, options = {}) {
			super(type);
			this[kData] = options.data === void 0 ? null : options.data;
		}
		/**
		* @type {*}
		*/
		get data() {
			return this[kData];
		}
	};
	Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
	module.exports = {
		CloseEvent,
		ErrorEvent,
		Event,
		EventTarget: {
			/**
			* Register an event listener.
			*
			* @param {String} type A string representing the event type to listen for
			* @param {(Function|Object)} handler The listener to add
			* @param {Object} [options] An options object specifies characteristics about
			*     the event listener
			* @param {Boolean} [options.once=false] A `Boolean` indicating that the
			*     listener should be invoked at most once after being added. If `true`,
			*     the listener would be automatically removed when invoked.
			* @public
			*/
			addEventListener(type, handler, options = {}) {
				for (const listener of this.listeners(type)) if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) return;
				let wrapper;
				if (type === "message") wrapper = function onMessage(data, isBinary) {
					const event = new MessageEvent("message", { data: isBinary ? data : data.toString() });
					event[kTarget] = this;
					callListener(handler, this, event);
				};
				else if (type === "close") wrapper = function onClose(code, message) {
					const event = new CloseEvent("close", {
						code,
						reason: message.toString(),
						wasClean: this._closeFrameReceived && this._closeFrameSent
					});
					event[kTarget] = this;
					callListener(handler, this, event);
				};
				else if (type === "error") wrapper = function onError(error) {
					const event = new ErrorEvent("error", {
						error,
						message: error.message
					});
					event[kTarget] = this;
					callListener(handler, this, event);
				};
				else if (type === "open") wrapper = function onOpen() {
					const event = new Event("open");
					event[kTarget] = this;
					callListener(handler, this, event);
				};
				else return;
				wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
				wrapper[kListener] = handler;
				if (options.once) this.once(type, wrapper);
				else this.on(type, wrapper);
			},
			/**
			* Remove an event listener.
			*
			* @param {String} type A string representing the event type to remove
			* @param {(Function|Object)} handler The listener to remove
			* @public
			*/
			removeEventListener(type, handler) {
				for (const listener of this.listeners(type)) if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
					this.removeListener(type, listener);
					break;
				}
			}
		},
		MessageEvent
	};
	/**
	* Call an event listener
	*
	* @param {(Function|Object)} listener The listener to call
	* @param {*} thisArg The value to use as `this`` when calling the listener
	* @param {Event} event The event to pass to the listener
	* @private
	*/
	function callListener(listener, thisArg, event) {
		if (typeof listener === "object" && listener.handleEvent) listener.handleEvent.call(listener, event);
		else listener.call(thisArg, event);
	}
}));
// node_modules/ws/lib/extension.js
var require_extension = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { tokenChars } = require_validation();
	/**
	* Adds an offer to the map of extension offers or a parameter to the map of
	* parameters.
	*
	* @param {Object} dest The map of extension offers or parameters
	* @param {String} name The extension or parameter name
	* @param {(Object|Boolean|String)} elem The extension parameters or the
	*     parameter value
	* @private
	*/
	function push(dest, name, elem) {
		if (dest[name] === void 0) dest[name] = [elem];
		else dest[name].push(elem);
	}
	/**
	* Parses the `Sec-WebSocket-Extensions` header into an object.
	*
	* @param {String} header The field value of the header
	* @return {Object} The parsed object
	* @public
	*/
	function parse(header) {
		const offers = Object.create(null);
		let params = Object.create(null);
		let mustUnescape = false;
		let isEscaping = false;
		let inQuotes = false;
		let extensionName;
		let paramName;
		let start = -1;
		let code = -1;
		let end = -1;
		let i = 0;
		for (; i < header.length; i++) {
			code = header.charCodeAt(i);
			if (extensionName === void 0) {
				if (end === -1 && tokenChars[code] === 1) {
					if (start === -1) start = i;
				} else if (i !== 0 && (code === 32 || code === 9)) {
					if (end === -1 && start !== -1) end = i;
				} else if (code === 59 || code === 44) {
					if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
					if (end === -1) end = i;
					const name = header.slice(start, end);
					if (code === 44) {
						push(offers, name, params);
						params = Object.create(null);
					} else extensionName = name;
					start = end = -1;
				} else throw new SyntaxError(`Unexpected character at index ${i}`);
			} else if (paramName === void 0) {
				if (end === -1 && tokenChars[code] === 1) {
					if (start === -1) start = i;
				} else if (code === 32 || code === 9) {
					if (end === -1 && start !== -1) end = i;
				} else if (code === 59 || code === 44) {
					if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
					if (end === -1) end = i;
					push(params, header.slice(start, end), true);
					if (code === 44) {
						push(offers, extensionName, params);
						params = Object.create(null);
						extensionName = void 0;
					}
					start = end = -1;
				} else if (code === 61 && start !== -1 && end === -1) {
					paramName = header.slice(start, i);
					start = end = -1;
				} else throw new SyntaxError(`Unexpected character at index ${i}`);
			} else if (isEscaping) {
				if (tokenChars[code] !== 1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (start === -1) start = i;
				else if (!mustUnescape) mustUnescape = true;
				isEscaping = false;
			} else if (inQuotes) {
				if (tokenChars[code] === 1) {
					if (start === -1) start = i;
				} else if (code === 34 && start !== -1) {
					inQuotes = false;
					end = i;
				} else if (code === 92) isEscaping = true;
				else throw new SyntaxError(`Unexpected character at index ${i}`);
			} else if (code === 34 && header.charCodeAt(i - 1) === 61) inQuotes = true;
			else if (end === -1 && tokenChars[code] === 1) {
				if (start === -1) start = i;
			} else if (start !== -1 && (code === 32 || code === 9)) {
				if (end === -1) end = i;
			} else if (code === 59 || code === 44) {
				if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (end === -1) end = i;
				let value = header.slice(start, end);
				if (mustUnescape) {
					value = value.replace(/\\/g, "");
					mustUnescape = false;
				}
				push(params, paramName, value);
				if (code === 44) {
					push(offers, extensionName, params);
					params = Object.create(null);
					extensionName = void 0;
				}
				paramName = void 0;
				start = end = -1;
			} else throw new SyntaxError(`Unexpected character at index ${i}`);
		}
		if (start === -1 || inQuotes || code === 32 || code === 9) throw new SyntaxError("Unexpected end of input");
		if (end === -1) end = i;
		const token = header.slice(start, end);
		if (extensionName === void 0) push(offers, token, params);
		else {
			if (paramName === void 0) push(params, token, true);
			else if (mustUnescape) push(params, paramName, token.replace(/\\/g, ""));
			else push(params, paramName, token);
			push(offers, extensionName, params);
		}
		return offers;
	}
	/**
	* Builds the `Sec-WebSocket-Extensions` header field value.
	*
	* @param {Object} extensions The map of extensions and parameters to format
	* @return {String} A string representing the given object
	* @public
	*/
	function format(extensions) {
		return Object.keys(extensions).map((extension) => {
			let configurations = extensions[extension];
			if (!Array.isArray(configurations)) configurations = [configurations];
			return configurations.map((params) => {
				return [extension].concat(Object.keys(params).map((k) => {
					let values = params[k];
					if (!Array.isArray(values)) values = [values];
					return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
				})).join("; ");
			}).join(", ");
		}).join(", ");
	}
	module.exports = {
		format,
		parse
	};
}));
// node_modules/ws/lib/websocket.js
var require_websocket = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const EventEmitter = require("events");
	const https = require("https");
	const http = require("http");
	const net = require("net");
	const querystring = require("querystring");
	const tls = require("tls");
	const { randomBytes, createHash } = require("crypto");
	const { Duplex, Readable } = require("stream");
	const { URL } = require("url");
	const PerMessageDeflate = require_permessage_deflate();
	const Receiver = require_receiver();
	const Sender = require_sender();
	const { isBlob } = require_validation();
	const { BINARY_TYPES, CLOSE_TIMEOUT, EMPTY_BUFFER, GUID, kForOnEventAttribute, kListener, kStatusCode, kWebSocket, NOOP } = require_constants();
	const { EventTarget: { addEventListener, removeEventListener } } = require_event_target();
	const { format, parse } = require_extension();
	const { toBuffer } = require_buffer_util();
	const kAborted = Symbol("kAborted");
	const protocolVersions = [8, 13];
	const readyStates = [
		"CONNECTING",
		"OPEN",
		"CLOSING",
		"CLOSED"
	];
	const subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
	/**
	* Class representing a WebSocket.
	*
	* @extends EventEmitter
	*/
	var WebSocket = class WebSocket extends EventEmitter {
		/**
		* Create a new `WebSocket`.
		*
		* @param {(String|URL)} address The URL to which to connect
		* @param {(String|String[])} [protocols] The subprotocols
		* @param {Object} [options] Connection options
		*/
		constructor(address, protocols, options) {
			super();
			this._binaryType = BINARY_TYPES[0];
			this._closeCode = 1006;
			this._closeFrameReceived = false;
			this._closeFrameSent = false;
			this._closeMessage = EMPTY_BUFFER;
			this._closeTimer = null;
			this._errorEmitted = false;
			this._extensions = {};
			this._paused = false;
			this._protocol = "";
			this._readyState = WebSocket.CONNECTING;
			this._receiver = null;
			this._sender = null;
			this._socket = null;
			if (address !== null) {
				this._bufferedAmount = 0;
				this._isServer = false;
				this._redirects = 0;
				if (protocols === void 0) {
					if (!options || options.protocols === void 0) protocols = [];
					else if (Array.isArray(options.protocols)) protocols = options.protocols;
					else protocols = [options.protocols];
				} else if (!Array.isArray(protocols)) {
					if (typeof protocols === "object" && protocols !== null) {
						options = protocols;
						if (options.protocols === void 0) protocols = [];
						else if (Array.isArray(options.protocols)) protocols = options.protocols;
						else protocols = [options.protocols];
					} else protocols = [protocols];
				}
				options = initAsClient(this, address, protocols, options);
			} else this._isServer = true;
			if (options.autoPong) {
				this._autoPong = true;
				this._autoPongComplete = () => autoPongComplete(this);
				this._pendingAutoPongs = 0;
				this._maxPendingAutoPongs = options.maxPendingAutoPongs | 0;
			}
			this._closeTimeout = options.closeTimeout;
		}
		/**
		* For historical reasons, the custom "nodebuffer" type is used by the default
		* instead of "blob".
		*
		* @type {String}
		*/
		get binaryType() {
			return this._binaryType;
		}
		set binaryType(type) {
			if (!BINARY_TYPES.includes(type)) return;
			this._binaryType = type;
			if (this._receiver) this._receiver._binaryType = type;
		}
		/**
		* @type {Number}
		*/
		get bufferedAmount() {
			if (!this._socket) return this._bufferedAmount;
			return this._socket._writableState.length + this._sender._bufferedBytes;
		}
		/**
		* @type {String}
		*/
		get extensions() {
			return Object.keys(this._extensions).join();
		}
		/**
		* @type {Boolean}
		*/
		get isPaused() {
			return this._paused;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onclose() {
			return null;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onerror() {
			return null;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onopen() {
			return null;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onmessage() {
			return null;
		}
		/**
		* @type {String}
		*/
		get protocol() {
			return this._protocol;
		}
		/**
		* @type {Number}
		*/
		get readyState() {
			return this._readyState;
		}
		/**
		* @type {String}
		*/
		get url() {
			return this._url;
		}
		/**
		* Set up the socket and the internal resources.
		*
		* @param {Duplex} socket The network socket between the server and client
		* @param {Buffer} head The first packet of the upgraded stream
		* @param {Object} options Options object
		* @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
		*     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
		*     multiple times in the same tick
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Number} [options.maxBufferedChunks=0] The maximum number of
		*     buffered data chunks
		* @param {Number} [options.maxFragments=0] The maximum number of message
		*     fragments
		* @param {Number} [options.maxPayload=0] The maximum allowed message size
		* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
		*     not to skip UTF-8 validation for text and close messages
		* @private
		*/
		setSocket(socket, head, options) {
			const receiver = new Receiver({
				allowSynchronousEvents: options.allowSynchronousEvents,
				binaryType: this.binaryType,
				extensions: this._extensions,
				isServer: this._isServer,
				maxBufferedChunks: options.maxBufferedChunks,
				maxFragments: options.maxFragments,
				maxPayload: options.maxPayload,
				skipUTF8Validation: options.skipUTF8Validation
			});
			const sender = new Sender(socket, this._extensions, options.generateMask);
			this._receiver = receiver;
			this._sender = sender;
			this._socket = socket;
			receiver[kWebSocket] = this;
			sender[kWebSocket] = this;
			socket[kWebSocket] = this;
			receiver.on("conclude", receiverOnConclude);
			receiver.on("drain", receiverOnDrain);
			receiver.on("error", receiverOnError);
			receiver.on("message", receiverOnMessage);
			receiver.on("ping", receiverOnPing);
			receiver.on("pong", receiverOnPong);
			sender.onerror = senderOnError;
			if (socket.setTimeout) socket.setTimeout(0);
			if (socket.setNoDelay) socket.setNoDelay();
			if (head.length > 0) socket.unshift(head);
			socket.on("close", socketOnClose);
			socket.on("data", socketOnData);
			socket.on("end", socketOnEnd);
			socket.on("error", socketOnError);
			this._readyState = WebSocket.OPEN;
			this.emit("open");
		}
		/**
		* Emit the `'close'` event.
		*
		* @private
		*/
		emitClose() {
			if (!this._socket) {
				this._readyState = WebSocket.CLOSED;
				this.emit("close", this._closeCode, this._closeMessage);
				return;
			}
			if (this._extensions[PerMessageDeflate.extensionName]) this._extensions[PerMessageDeflate.extensionName].cleanup();
			this._receiver.removeAllListeners();
			this._readyState = WebSocket.CLOSED;
			this.emit("close", this._closeCode, this._closeMessage);
		}
		/**
		* Start a closing handshake.
		*
		*          +----------+   +-----------+   +----------+
		*     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
		*    |     +----------+   +-----------+   +----------+     |
		*          +----------+   +-----------+         |
		* CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
		*          +----------+   +-----------+   |
		*    |           |                        |   +---+        |
		*                +------------------------+-->|fin| - - - -
		*    |         +---+                      |   +---+
		*     - - - - -|fin|<---------------------+
		*              +---+
		*
		* @param {Number} [code] Status code explaining why the connection is closing
		* @param {(String|Buffer)} [data] The reason why the connection is
		*     closing
		* @public
		*/
		close(code, data) {
			if (this.readyState === WebSocket.CLOSED) return;
			if (this.readyState === WebSocket.CONNECTING) {
				abortHandshake(this, this._req, "WebSocket was closed before the connection was established");
				return;
			}
			if (this.readyState === WebSocket.CLOSING) {
				if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) this._socket.end();
				return;
			}
			this._sender.close(code, data, !this._isServer, (err) => {
				if (err) return;
				this._closeFrameSent = true;
				if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) this._socket.end();
			});
			this._readyState = WebSocket.CLOSING;
			setCloseTimer(this);
		}
		/**
		* Pause the socket.
		*
		* @public
		*/
		pause() {
			if (this.readyState === WebSocket.CONNECTING || this.readyState === WebSocket.CLOSED) return;
			this._paused = true;
			this._socket.pause();
		}
		/**
		* Send a ping.
		*
		* @param {*} [data] The data to send
		* @param {Boolean} [mask] Indicates whether or not to mask `data`
		* @param {Function} [cb] Callback which is executed when the ping is sent
		* @public
		*/
		ping(data, mask, cb) {
			if (this.readyState === WebSocket.CONNECTING) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
			if (typeof data === "function") {
				cb = data;
				data = mask = void 0;
			} else if (typeof mask === "function") {
				cb = mask;
				mask = void 0;
			}
			if (typeof data === "number") data = data.toString();
			if (this.readyState !== WebSocket.OPEN) {
				sendAfterClose(this, data, cb);
				return;
			}
			if (mask === void 0) mask = !this._isServer;
			this._sender.ping(data || EMPTY_BUFFER, mask, cb);
		}
		/**
		* Send a pong.
		*
		* @param {*} [data] The data to send
		* @param {Boolean} [mask] Indicates whether or not to mask `data`
		* @param {Function} [cb] Callback which is executed when the pong is sent
		* @public
		*/
		pong(data, mask, cb) {
			if (this.readyState === WebSocket.CONNECTING) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
			if (typeof data === "function") {
				cb = data;
				data = mask = void 0;
			} else if (typeof mask === "function") {
				cb = mask;
				mask = void 0;
			}
			if (typeof data === "number") data = data.toString();
			if (this.readyState !== WebSocket.OPEN) {
				sendAfterClose(this, data, cb);
				return;
			}
			if (mask === void 0) mask = !this._isServer;
			this._sender.pong(data || EMPTY_BUFFER, mask, cb);
		}
		/**
		* Resume the socket.
		*
		* @public
		*/
		resume() {
			if (this.readyState === WebSocket.CONNECTING || this.readyState === WebSocket.CLOSED) return;
			this._paused = false;
			if (!this._receiver._writableState.needDrain) this._socket.resume();
		}
		/**
		* Send a data message.
		*
		* @param {*} data The message to send
		* @param {Object} [options] Options object
		* @param {Boolean} [options.binary] Specifies whether `data` is binary or
		*     text
		* @param {Boolean} [options.compress] Specifies whether or not to compress
		*     `data`
		* @param {Boolean} [options.fin=true] Specifies whether the fragment is the
		*     last one
		* @param {Boolean} [options.mask] Specifies whether or not to mask `data`
		* @param {Function} [cb] Callback which is executed when data is written out
		* @public
		*/
		send(data, options, cb) {
			if (this.readyState === WebSocket.CONNECTING) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
			if (typeof options === "function") {
				cb = options;
				options = {};
			}
			if (typeof data === "number") data = data.toString();
			if (this.readyState !== WebSocket.OPEN) {
				sendAfterClose(this, data, cb);
				return;
			}
			const opts = {
				binary: typeof data !== "string",
				mask: !this._isServer,
				compress: true,
				fin: true,
				...options
			};
			if (!this._extensions[PerMessageDeflate.extensionName]) opts.compress = false;
			this._sender.send(data || EMPTY_BUFFER, opts, cb);
		}
		/**
		* Forcibly close the connection.
		*
		* @public
		*/
		terminate() {
			if (this.readyState === WebSocket.CLOSED) return;
			if (this.readyState === WebSocket.CONNECTING) {
				abortHandshake(this, this._req, "WebSocket was closed before the connection was established");
				return;
			}
			if (this._socket) {
				this._readyState = WebSocket.CLOSING;
				this._socket.destroy();
			}
		}
	};
	/**
	* @constant {Number} CONNECTING
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket, "CONNECTING", {
		enumerable: true,
		value: readyStates.indexOf("CONNECTING")
	});
	/**
	* @constant {Number} CONNECTING
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket.prototype, "CONNECTING", {
		enumerable: true,
		value: readyStates.indexOf("CONNECTING")
	});
	/**
	* @constant {Number} OPEN
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket, "OPEN", {
		enumerable: true,
		value: readyStates.indexOf("OPEN")
	});
	/**
	* @constant {Number} OPEN
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket.prototype, "OPEN", {
		enumerable: true,
		value: readyStates.indexOf("OPEN")
	});
	/**
	* @constant {Number} CLOSING
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket, "CLOSING", {
		enumerable: true,
		value: readyStates.indexOf("CLOSING")
	});
	/**
	* @constant {Number} CLOSING
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket.prototype, "CLOSING", {
		enumerable: true,
		value: readyStates.indexOf("CLOSING")
	});
	/**
	* @constant {Number} CLOSED
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket, "CLOSED", {
		enumerable: true,
		value: readyStates.indexOf("CLOSED")
	});
	/**
	* @constant {Number} CLOSED
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket.prototype, "CLOSED", {
		enumerable: true,
		value: readyStates.indexOf("CLOSED")
	});
	[
		"binaryType",
		"bufferedAmount",
		"extensions",
		"isPaused",
		"protocol",
		"readyState",
		"url"
	].forEach((property) => {
		Object.defineProperty(WebSocket.prototype, property, { enumerable: true });
	});
	[
		"open",
		"error",
		"close",
		"message"
	].forEach((method) => {
		Object.defineProperty(WebSocket.prototype, `on${method}`, {
			enumerable: true,
			get() {
				for (const listener of this.listeners(method)) if (listener[kForOnEventAttribute]) return listener[kListener];
				return null;
			},
			set(handler) {
				for (const listener of this.listeners(method)) if (listener[kForOnEventAttribute]) {
					this.removeListener(method, listener);
					break;
				}
				if (typeof handler !== "function") return;
				this.addEventListener(method, handler, { [kForOnEventAttribute]: true });
			}
		});
	});
	WebSocket.prototype.addEventListener = addEventListener;
	WebSocket.prototype.removeEventListener = removeEventListener;
	module.exports = WebSocket;
	/**
	* Initialize a WebSocket client.
	*
	* @param {WebSocket} websocket The client to initialize
	* @param {(String|URL)} address The URL to which to connect
	* @param {Array} protocols The subprotocols
	* @param {Object} [options] Connection options
	* @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether any
	*     of the `'message'`, `'ping'`, and `'pong'` events can be emitted multiple
	*     times in the same tick
	* @param {Boolean} [options.autoPong=true] Specifies whether or not to
	*     automatically send a pong in response to a ping
	* @param {Number} [options.closeTimeout=30000] Duration in milliseconds to wait
	*     for the closing handshake to finish after `websocket.close()` is called
	* @param {Function} [options.finishRequest] A function which can be used to
	*     customize the headers of each http request before it is sent
	* @param {Boolean} [options.followRedirects=false] Whether or not to follow
	*     redirects
	* @param {Function} [options.generateMask] The function used to generate the
	*     masking key
	* @param {Number} [options.handshakeTimeout] Timeout in milliseconds for the
	*     handshake request
	* @param {Number} [options.maxBufferedChunks=262144] The maximum number of
	*     buffered data chunks
	* @param {Number} [options.maxFragments=16384] The maximum number of message
	*     fragments
	* @param {Number} [options.maxPayload=104857600] The maximum allowed message
	*     size
	* @param {Number} [options.maxPendingAutoPongs=60] The maximum number of
	*     pending automatic pongs
	* @param {Number} [options.maxRedirects=10] The maximum number of redirects
	*     allowed
	* @param {String} [options.origin] Value of the `Origin` or
	*     `Sec-WebSocket-Origin` header
	* @param {(Boolean|Object)} [options.perMessageDeflate=true] Enable/disable
	*     permessage-deflate
	* @param {Number} [options.protocolVersion=13] Value of the
	*     `Sec-WebSocket-Version` header
	* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
	*     not to skip UTF-8 validation for text and close messages
	* @return {Object} The resolved options object used for initialization
	* @private
	*/
	function initAsClient(websocket, address, protocols, options) {
		const opts = {
			allowSynchronousEvents: true,
			autoPong: true,
			closeTimeout: CLOSE_TIMEOUT,
			protocolVersion: protocolVersions[1],
			maxBufferedChunks: 262144,
			maxFragments: 16384,
			maxPayload: 104857600,
			maxPendingAutoPongs: 60,
			skipUTF8Validation: false,
			perMessageDeflate: true,
			followRedirects: false,
			maxRedirects: 10,
			...options,
			socketPath: void 0,
			hostname: void 0,
			protocol: void 0,
			protocols: void 0,
			timeout: void 0,
			method: "GET",
			host: void 0,
			path: void 0,
			port: void 0
		};
		if (!protocolVersions.includes(opts.protocolVersion)) throw new RangeError(`Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`);
		let parsedUrl;
		if (address instanceof URL) parsedUrl = address;
		else try {
			parsedUrl = new URL(address);
		} catch {
			throw new SyntaxError(`Invalid URL: ${address}`);
		}
		if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
			parsedUrl = new URL(parsedUrl);
			parsedUrl.protocol = parsedUrl.protocol === "http:" ? "ws:" : "wss:";
		}
		websocket._url = parsedUrl.href;
		const isSecure = parsedUrl.protocol === "wss:";
		const isIpcUrl = parsedUrl.protocol === "ws+unix:";
		let invalidUrlMessage;
		if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) invalidUrlMessage = "The URL's protocol must be one of \"ws:\", \"wss:\", \"http:\", \"https:\", or \"ws+unix:\"";
		else if (isIpcUrl && !parsedUrl.pathname) invalidUrlMessage = "The URL's pathname is empty";
		else if (parsedUrl.hash) invalidUrlMessage = "The URL contains a fragment identifier";
		if (invalidUrlMessage) {
			const err = new SyntaxError(invalidUrlMessage);
			if (websocket._redirects === 0) throw err;
			else {
				emitErrorAndClose(websocket, err);
				return;
			}
		}
		const defaultPort = isSecure ? 443 : 80;
		const key = randomBytes(16).toString("base64");
		const request = isSecure ? https.request : http.request;
		const protocolSet = /* @__PURE__ */ new Set();
		let perMessageDeflate;
		opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
		opts.defaultPort = opts.defaultPort || defaultPort;
		opts.port = parsedUrl.port || defaultPort;
		opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
		opts.headers = {
			...opts.headers,
			"Sec-WebSocket-Version": opts.protocolVersion,
			"Sec-WebSocket-Key": key,
			Connection: "Upgrade",
			Upgrade: "websocket"
		};
		opts.path = parsedUrl.pathname + parsedUrl.search;
		opts.timeout = opts.handshakeTimeout;
		if (opts.perMessageDeflate) {
			perMessageDeflate = new PerMessageDeflate({
				...opts.perMessageDeflate,
				isServer: false,
				maxPayload: opts.maxPayload
			});
			opts.headers["Sec-WebSocket-Extensions"] = format({ [PerMessageDeflate.extensionName]: perMessageDeflate.offer() });
		}
		if (protocols.length) {
			for (const protocol of protocols) {
				if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) throw new SyntaxError("An invalid or duplicated subprotocol was specified");
				protocolSet.add(protocol);
			}
			opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
		}
		if (opts.origin) {
			if (opts.protocolVersion < 13) opts.headers["Sec-WebSocket-Origin"] = opts.origin;
			else opts.headers.Origin = opts.origin;
		}
		if (parsedUrl.username || parsedUrl.password) opts.auth = `${querystring.unescape(parsedUrl.username)}:${querystring.unescape(parsedUrl.password)}`;
		if (isIpcUrl) {
			const i = opts.path.indexOf(":");
			if (i === -1) {
				opts.socketPath = opts.path;
				opts.path = "";
			} else {
				opts.socketPath = opts.path.slice(0, i);
				opts.path = opts.path.slice(i + 1);
			}
		}
		let req;
		if (opts.followRedirects) {
			if (websocket._redirects === 0) {
				websocket._originalIpc = isIpcUrl;
				websocket._originalSecure = isSecure;
				websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
				const headers = options && options.headers;
				options = {
					...options,
					headers: {}
				};
				if (headers) for (const [key, value] of Object.entries(headers)) options.headers[key.toLowerCase()] = value;
			} else if (websocket.listenerCount("redirect") === 0) {
				const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
				if (!isSameHost || websocket._originalSecure && !isSecure) {
					delete opts.headers.authorization;
					delete opts.headers.cookie;
					if (!isSameHost) delete opts.headers.host;
					opts.auth = void 0;
				}
			}
			if (opts.auth && !options.headers.authorization) options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
			req = websocket._req = request(opts);
			if (websocket._redirects) websocket.emit("redirect", websocket.url, req);
		} else req = websocket._req = request(opts);
		if (opts.timeout) req.on("timeout", () => {
			abortHandshake(websocket, req, "Opening handshake has timed out");
		});
		req.on("error", (err) => {
			if (req === null || req[kAborted]) return;
			req = websocket._req = null;
			emitErrorAndClose(websocket, err);
		});
		req.on("response", (res) => {
			const location = res.headers.location;
			const statusCode = res.statusCode;
			if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
				if (++websocket._redirects > opts.maxRedirects) {
					abortHandshake(websocket, req, "Maximum redirects exceeded");
					return;
				}
				req.abort();
				let addr;
				try {
					addr = new URL(location, address);
				} catch (e) {
					emitErrorAndClose(websocket, /* @__PURE__ */ new SyntaxError(`Invalid URL: ${location}`));
					return;
				}
				initAsClient(websocket, addr, protocols, options);
			} else if (!websocket.emit("unexpected-response", req, res)) abortHandshake(websocket, req, `Unexpected server response: ${res.statusCode}`);
		});
		req.on("upgrade", (res, socket, head) => {
			websocket.emit("upgrade", res);
			if (websocket.readyState !== WebSocket.CONNECTING) return;
			req = websocket._req = null;
			const upgrade = res.headers.upgrade;
			if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
				abortHandshake(websocket, socket, "Invalid Upgrade header");
				return;
			}
			const digest = createHash("sha1").update(key + GUID).digest("base64");
			if (res.headers["sec-websocket-accept"] !== digest) {
				abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
				return;
			}
			const serverProt = res.headers["sec-websocket-protocol"];
			let protError;
			if (serverProt !== void 0) {
				if (!protocolSet.size) protError = "Server sent a subprotocol but none was requested";
				else if (!protocolSet.has(serverProt)) protError = "Server sent an invalid subprotocol";
			} else if (protocolSet.size) protError = "Server sent no subprotocol";
			if (protError) {
				abortHandshake(websocket, socket, protError);
				return;
			}
			if (serverProt) websocket._protocol = serverProt;
			const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
			if (secWebSocketExtensions !== void 0) {
				if (!perMessageDeflate) {
					abortHandshake(websocket, socket, "Server sent a Sec-WebSocket-Extensions header but no extension was requested");
					return;
				}
				let extensions;
				try {
					extensions = parse(secWebSocketExtensions);
				} catch (err) {
					abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Extensions header");
					return;
				}
				const extensionNames = Object.keys(extensions);
				if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate.extensionName) {
					abortHandshake(websocket, socket, "Server indicated an extension that was not requested");
					return;
				}
				try {
					perMessageDeflate.accept(extensions[PerMessageDeflate.extensionName]);
				} catch (err) {
					abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Extensions header");
					return;
				}
				websocket._extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
			}
			websocket.setSocket(socket, head, {
				allowSynchronousEvents: opts.allowSynchronousEvents,
				generateMask: opts.generateMask,
				maxBufferedChunks: opts.maxBufferedChunks,
				maxFragments: opts.maxFragments,
				maxPayload: opts.maxPayload,
				skipUTF8Validation: opts.skipUTF8Validation
			});
		});
		if (opts.finishRequest) opts.finishRequest(req, websocket);
		else req.end();
		return opts;
	}
	/**
	* Emit the `'error'` and `'close'` events.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @param {Error} The error to emit
	* @private
	*/
	function emitErrorAndClose(websocket, err) {
		websocket._readyState = WebSocket.CLOSING;
		websocket._errorEmitted = true;
		websocket.emit("error", err);
		websocket.emitClose();
	}
	/**
	* Create a `net.Socket` and initiate a connection.
	*
	* @param {Object} options Connection options
	* @return {net.Socket} The newly created socket used to start the connection
	* @private
	*/
	function netConnect(options) {
		options.path = options.socketPath;
		return net.connect(options);
	}
	/**
	* Create a `tls.TLSSocket` and initiate a connection.
	*
	* @param {Object} options Connection options
	* @return {tls.TLSSocket} The newly created socket used to start the connection
	* @private
	*/
	function tlsConnect(options) {
		options.path = void 0;
		if (!options.servername && options.servername !== "") options.servername = net.isIP(options.host) ? "" : options.host;
		return tls.connect(options);
	}
	/**
	* Abort the handshake and emit an error.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @param {(http.ClientRequest|net.Socket|tls.Socket)} stream The request to
	*     abort or the socket to destroy
	* @param {String} message The error message
	* @private
	*/
	function abortHandshake(websocket, stream, message) {
		websocket._readyState = WebSocket.CLOSING;
		const err = new Error(message);
		Error.captureStackTrace(err, abortHandshake);
		if (stream.setHeader) {
			stream[kAborted] = true;
			stream.abort();
			if (stream.socket && !stream.socket.destroyed) stream.socket.destroy();
			process.nextTick(emitErrorAndClose, websocket, err);
		} else {
			stream.destroy(err);
			stream.once("error", websocket.emit.bind(websocket, "error"));
			stream.once("close", websocket.emitClose.bind(websocket));
		}
	}
	/**
	* Handle cases where the `ping()`, `pong()`, or `send()` methods are called
	* when the `readyState` attribute is `CLOSING` or `CLOSED`.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @param {*} [data] The data to send
	* @param {Function} [cb] Callback
	* @private
	*/
	function sendAfterClose(websocket, data, cb) {
		if (data) {
			const length = isBlob(data) ? data.size : toBuffer(data).length;
			if (websocket._socket) websocket._sender._bufferedBytes += length;
			else websocket._bufferedAmount += length;
		}
		if (cb) {
			const err = /* @__PURE__ */ new Error(`WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`);
			process.nextTick(cb, err);
		}
	}
	/**
	* The listener of the `Receiver` `'conclude'` event.
	*
	* @param {Number} code The status code
	* @param {Buffer} reason The reason for closing
	* @private
	*/
	function receiverOnConclude(code, reason) {
		const websocket = this[kWebSocket];
		websocket._closeFrameReceived = true;
		websocket._closeCode = code;
		if (reason.length === 0) websocket._closeMessage = EMPTY_BUFFER;
		else {
			websocket._closeMessage = Buffer.allocUnsafeSlow(reason.length);
			websocket._closeMessage.set(reason);
		}
		if (websocket._socket[kWebSocket] === void 0) return;
		websocket._socket.removeListener("data", socketOnData);
		process.nextTick(resume, websocket._socket);
		if (code === 1005) websocket.close();
		else websocket.close(code, reason);
	}
	/**
	* The listener of the `Receiver` `'drain'` event.
	*
	* @private
	*/
	function receiverOnDrain() {
		const websocket = this[kWebSocket];
		if (!websocket.isPaused) websocket._socket.resume();
	}
	/**
	* The listener of the `Receiver` `'error'` event.
	*
	* @param {(RangeError|Error)} err The emitted error
	* @private
	*/
	function receiverOnError(err) {
		const websocket = this[kWebSocket];
		if (websocket._socket[kWebSocket] !== void 0) {
			websocket._socket.removeListener("data", socketOnData);
			process.nextTick(resume, websocket._socket);
			websocket.close(err[kStatusCode]);
		}
		if (!websocket._errorEmitted) {
			websocket._errorEmitted = true;
			websocket.emit("error", err);
		}
	}
	/**
	* The listener of the `Receiver` `'finish'` event.
	*
	* @private
	*/
	function receiverOnFinish() {
		this[kWebSocket].emitClose();
	}
	/**
	* The listener of the `Receiver` `'message'` event.
	*
	* @param {Buffer|ArrayBuffer|Buffer[])} data The message
	* @param {Boolean} isBinary Specifies whether the message is binary or not
	* @private
	*/
	function receiverOnMessage(data, isBinary) {
		this[kWebSocket].emit("message", data, isBinary);
	}
	/**
	* The listener of the `Receiver` `'ping'` event.
	*
	* @param {Buffer} data The data included in the ping frame
	* @private
	*/
	function receiverOnPing(data) {
		const websocket = this[kWebSocket];
		if (websocket._autoPong && websocket.readyState === WebSocket.OPEN) {
			if (websocket._maxPendingAutoPongs > 0 && websocket._pendingAutoPongs >= websocket._maxPendingAutoPongs) websocket.terminate();
			else {
				websocket._pendingAutoPongs++;
				websocket.pong(data, !this._isServer, websocket._autoPongComplete);
			}
		}
		websocket.emit("ping", data);
	}
	/**
	* The callback for automatic pong responses.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @private
	*/
	function autoPongComplete(websocket) {
		websocket._pendingAutoPongs--;
	}
	/**
	* The listener of the `Receiver` `'pong'` event.
	*
	* @param {Buffer} data The data included in the pong frame
	* @private
	*/
	function receiverOnPong(data) {
		this[kWebSocket].emit("pong", data);
	}
	/**
	* Resume a readable stream
	*
	* @param {Readable} stream The readable stream
	* @private
	*/
	function resume(stream) {
		stream.resume();
	}
	/**
	* The `Sender` error event handler.
	*
	* @param {Error} The error
	* @private
	*/
	function senderOnError(err) {
		const websocket = this[kWebSocket];
		if (websocket.readyState === WebSocket.CLOSED) return;
		if (websocket.readyState === WebSocket.OPEN) {
			websocket._readyState = WebSocket.CLOSING;
			setCloseTimer(websocket);
		}
		this._socket.end();
		if (!websocket._errorEmitted) {
			websocket._errorEmitted = true;
			websocket.emit("error", err);
		}
	}
	/**
	* Set a timer to destroy the underlying raw socket of a WebSocket.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @private
	*/
	function setCloseTimer(websocket) {
		websocket._closeTimer = setTimeout(websocket._socket.destroy.bind(websocket._socket), websocket._closeTimeout);
	}
	/**
	* The listener of the socket `'close'` event.
	*
	* @private
	*/
	function socketOnClose() {
		const websocket = this[kWebSocket];
		this.removeListener("close", socketOnClose);
		this.removeListener("data", socketOnData);
		this.removeListener("end", socketOnEnd);
		websocket._readyState = WebSocket.CLOSING;
		if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
			const chunk = this.read(this._readableState.length);
			websocket._receiver.write(chunk);
		}
		websocket._receiver.end();
		this[kWebSocket] = void 0;
		clearTimeout(websocket._closeTimer);
		if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) websocket.emitClose();
		else {
			websocket._receiver.on("error", receiverOnFinish);
			websocket._receiver.on("finish", receiverOnFinish);
		}
	}
	/**
	* The listener of the socket `'data'` event.
	*
	* @param {Buffer} chunk A chunk of data
	* @private
	*/
	function socketOnData(chunk) {
		if (!this[kWebSocket]._receiver.write(chunk)) this.pause();
	}
	/**
	* The listener of the socket `'end'` event.
	*
	* @private
	*/
	function socketOnEnd() {
		const websocket = this[kWebSocket];
		websocket._readyState = WebSocket.CLOSING;
		websocket._receiver.end();
		this.end();
	}
	/**
	* The listener of the socket `'error'` event.
	*
	* @private
	*/
	function socketOnError() {
		const websocket = this[kWebSocket];
		this.removeListener("error", socketOnError);
		this.on("error", NOOP);
		if (websocket) {
			websocket._readyState = WebSocket.CLOSING;
			this.destroy();
		}
	}
}));
// node_modules/ws/lib/stream.js
var require_stream = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	require_websocket();
	const { Duplex } = require("stream");
	/**
	* Emits the `'close'` event on a stream.
	*
	* @param {Duplex} stream The stream.
	* @private
	*/
	function emitClose(stream) {
		stream.emit("close");
	}
	/**
	* The listener of the `'end'` event.
	*
	* @private
	*/
	function duplexOnEnd() {
		if (!this.destroyed && this._writableState.finished) this.destroy();
	}
	/**
	* The listener of the `'error'` event.
	*
	* @param {Error} err The error
	* @private
	*/
	function duplexOnError(err) {
		this.removeListener("error", duplexOnError);
		this.destroy();
		if (this.listenerCount("error") === 0) this.emit("error", err);
	}
	/**
	* Wraps a `WebSocket` in a duplex stream.
	*
	* @param {WebSocket} ws The `WebSocket` to wrap
	* @param {Object} [options] The options for the `Duplex` constructor
	* @return {Duplex} The duplex stream
	* @public
	*/
	function createWebSocketStream(ws, options) {
		let terminateOnDestroy = true;
		const duplex = new Duplex({
			...options,
			autoDestroy: false,
			emitClose: false,
			objectMode: false,
			writableObjectMode: false
		});
		ws.on("message", function message(msg, isBinary) {
			const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
			if (!duplex.push(data)) ws.pause();
		});
		ws.once("error", function error(err) {
			if (duplex.destroyed) return;
			terminateOnDestroy = false;
			duplex.destroy(err);
		});
		ws.once("close", function close() {
			if (duplex.destroyed) return;
			duplex.push(null);
		});
		duplex._destroy = function(err, callback) {
			if (ws.readyState === ws.CLOSED) {
				callback(err);
				process.nextTick(emitClose, duplex);
				return;
			}
			let called = false;
			ws.once("error", function error(err) {
				called = true;
				callback(err);
			});
			ws.once("close", function close() {
				if (!called) callback(err);
				process.nextTick(emitClose, duplex);
			});
			if (terminateOnDestroy) ws.terminate();
		};
		duplex._final = function(callback) {
			if (ws.readyState === ws.CONNECTING) {
				ws.once("open", function open() {
					duplex._final(callback);
				});
				return;
			}
			if (ws._socket === null) return;
			if (ws._socket._writableState.finished) {
				callback();
				if (duplex._readableState.endEmitted) duplex.destroy();
			} else {
				ws._socket.once("finish", function finish() {
					callback();
				});
				ws.close();
			}
		};
		duplex._read = function() {
			if (ws.isPaused) ws.resume();
		};
		duplex._write = function(chunk, encoding, callback) {
			if (ws.readyState === ws.CONNECTING) {
				ws.once("open", function open() {
					duplex._write(chunk, encoding, callback);
				});
				return;
			}
			ws.send(chunk, callback);
		};
		duplex.on("end", duplexOnEnd);
		duplex.on("error", duplexOnError);
		return duplex;
	}
	module.exports = createWebSocketStream;
}));
// node_modules/ws/lib/subprotocol.js
var require_subprotocol = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { tokenChars } = require_validation();
	/**
	* Parses the `Sec-WebSocket-Protocol` header into a set of subprotocol names.
	*
	* @param {String} header The field value of the header
	* @return {Set} The subprotocol names
	* @public
	*/
	function parse(header) {
		const protocols = /* @__PURE__ */ new Set();
		let start = -1;
		let end = -1;
		let i = 0;
		for (; i < header.length; i++) {
			const code = header.charCodeAt(i);
			if (end === -1 && tokenChars[code] === 1) {
				if (start === -1) start = i;
			} else if (i !== 0 && (code === 32 || code === 9)) {
				if (end === -1 && start !== -1) end = i;
			} else if (code === 44) {
				if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (end === -1) end = i;
				const protocol = header.slice(start, end);
				if (protocols.has(protocol)) throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
				protocols.add(protocol);
				start = end = -1;
			} else throw new SyntaxError(`Unexpected character at index ${i}`);
		}
		if (start === -1 || end !== -1) throw new SyntaxError("Unexpected end of input");
		const protocol = header.slice(start, i);
		if (protocols.has(protocol)) throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
		protocols.add(protocol);
		return protocols;
	}
	module.exports = { parse };
}));
// node_modules/ws/lib/websocket-server.js
var require_websocket_server = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const EventEmitter = require("events");
	const http = require("http");
	const { Duplex } = require("stream");
	const { createHash } = require("crypto");
	const extension = require_extension();
	const PerMessageDeflate = require_permessage_deflate();
	const subprotocol = require_subprotocol();
	const WebSocket = require_websocket();
	const { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
	const keyRegex = /^[+/0-9A-Za-z]{22}==$/;
	const RUNNING = 0;
	const CLOSING = 1;
	const CLOSED = 2;
	/**
	* Class representing a WebSocket server.
	*
	* @extends EventEmitter
	*/
	var WebSocketServer = class extends EventEmitter {
		/**
		* Create a `WebSocketServer` instance.
		*
		* @param {Object} options Configuration options
		* @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
		*     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
		*     multiple times in the same tick
		* @param {Boolean} [options.autoPong=true] Specifies whether or not to
		*     automatically send a pong in response to a ping
		* @param {Number} [options.backlog=511] The maximum length of the queue of
		*     pending connections
		* @param {Boolean} [options.clientTracking=true] Specifies whether or not to
		*     track clients
		* @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
		*     wait for the closing handshake to finish after `websocket.close()` is
		*     called
		* @param {Function} [options.handleProtocols] A hook to handle protocols
		* @param {String} [options.host] The hostname where to bind the server
		* @param {Number} [options.maxBufferedChunks=262144] The maximum number of
		*     buffered data chunks
		* @param {Number} [options.maxFragments=16384] The maximum number of message
		*     fragments
		* @param {Number} [options.maxPayload=104857600] The maximum allowed message
		*     size
		* @param {Number} [options.maxPendingAutoPongs=60] The maximum number of
		*     pending automatic pongs
		* @param {Boolean} [options.noServer=false] Enable no server mode
		* @param {String} [options.path] Accept only connections matching this path
		* @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
		*     permessage-deflate
		* @param {Number} [options.port] The port where to bind the server
		* @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
		*     server to use
		* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
		*     not to skip UTF-8 validation for text and close messages
		* @param {Function} [options.verifyClient] A hook to reject connections
		* @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
		*     class to use. It must be the `WebSocket` class or class that extends it
		* @param {Function} [callback] A listener for the `listening` event
		*/
		constructor(options, callback) {
			super();
			options = {
				allowSynchronousEvents: true,
				autoPong: true,
				maxBufferedChunks: 262144,
				maxFragments: 16384,
				maxPayload: 104857600,
				maxPendingAutoPongs: 60,
				skipUTF8Validation: false,
				perMessageDeflate: false,
				handleProtocols: null,
				clientTracking: true,
				closeTimeout: CLOSE_TIMEOUT,
				verifyClient: null,
				noServer: false,
				backlog: null,
				server: null,
				host: null,
				path: null,
				port: null,
				WebSocket,
				...options
			};
			if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) throw new TypeError("One and only one of the \"port\", \"server\", or \"noServer\" options must be specified");
			if (options.port != null) {
				this._server = http.createServer((req, res) => {
					const body = http.STATUS_CODES[426];
					res.writeHead(426, {
						"Content-Length": body.length,
						"Content-Type": "text/plain"
					});
					res.end(body);
				});
				this._server.listen(options.port, options.host, options.backlog, callback);
			} else if (options.server) this._server = options.server;
			if (this._server) {
				const emitConnection = this.emit.bind(this, "connection");
				this._removeListeners = addListeners(this._server, {
					listening: this.emit.bind(this, "listening"),
					error: this.emit.bind(this, "error"),
					upgrade: (req, socket, head) => {
						this.handleUpgrade(req, socket, head, emitConnection);
					}
				});
			}
			if (options.perMessageDeflate === true) options.perMessageDeflate = {};
			if (options.clientTracking) {
				this.clients = /* @__PURE__ */ new Set();
				this._shouldEmitClose = false;
			}
			this.options = options;
			this._state = RUNNING;
		}
		/**
		* Returns the bound address, the address family name, and port of the server
		* as reported by the operating system if listening on an IP socket.
		* If the server is listening on a pipe or UNIX domain socket, the name is
		* returned as a string.
		*
		* @return {(Object|String|null)} The address of the server
		* @public
		*/
		address() {
			if (this.options.noServer) throw new Error("The server is operating in \"noServer\" mode");
			if (!this._server) return null;
			return this._server.address();
		}
		/**
		* Stop the server from accepting new connections and emit the `'close'` event
		* when all existing connections are closed.
		*
		* @param {Function} [cb] A one-time listener for the `'close'` event
		* @public
		*/
		close(cb) {
			if (this._state === CLOSED) {
				if (cb) this.once("close", () => {
					cb(/* @__PURE__ */ new Error("The server is not running"));
				});
				process.nextTick(emitClose, this);
				return;
			}
			if (cb) this.once("close", cb);
			if (this._state === CLOSING) return;
			this._state = CLOSING;
			if (this.options.noServer || this.options.server) {
				if (this._server) {
					this._removeListeners();
					this._removeListeners = this._server = null;
				}
				if (this.clients) {
					if (!this.clients.size) process.nextTick(emitClose, this);
					else this._shouldEmitClose = true;
				} else process.nextTick(emitClose, this);
			} else {
				const server = this._server;
				this._removeListeners();
				this._removeListeners = this._server = null;
				server.close(() => {
					emitClose(this);
				});
			}
		}
		/**
		* See if a given request should be handled by this server instance.
		*
		* @param {http.IncomingMessage} req Request object to inspect
		* @return {Boolean} `true` if the request is valid, else `false`
		* @public
		*/
		shouldHandle(req) {
			if (this.options.path) {
				const index = req.url.indexOf("?");
				if ((index !== -1 ? req.url.slice(0, index) : req.url) !== this.options.path) return false;
			}
			return true;
		}
		/**
		* Handle a HTTP Upgrade request.
		*
		* @param {http.IncomingMessage} req The request object
		* @param {Duplex} socket The network socket between the server and client
		* @param {Buffer} head The first packet of the upgraded stream
		* @param {Function} cb Callback
		* @public
		*/
		handleUpgrade(req, socket, head, cb) {
			socket.on("error", socketOnError);
			const key = req.headers["sec-websocket-key"];
			const upgrade = req.headers.upgrade;
			const version = +req.headers["sec-websocket-version"];
			if (req.method !== "GET") {
				abortHandshakeOrEmitwsClientError(this, req, socket, 405, "Invalid HTTP method");
				return;
			}
			if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Invalid Upgrade header");
				return;
			}
			if (key === void 0 || !keyRegex.test(key)) {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Missing or invalid Sec-WebSocket-Key header");
				return;
			}
			if (version !== 13 && version !== 8) {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Missing or invalid Sec-WebSocket-Version header", { "Sec-WebSocket-Version": "13, 8" });
				return;
			}
			if (!this.shouldHandle(req)) {
				abortHandshake(socket, 400);
				return;
			}
			const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
			let protocols = /* @__PURE__ */ new Set();
			if (secWebSocketProtocol !== void 0) try {
				protocols = subprotocol.parse(secWebSocketProtocol);
			} catch (err) {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Invalid Sec-WebSocket-Protocol header");
				return;
			}
			const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
			const extensions = {};
			if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
				const perMessageDeflate = new PerMessageDeflate({
					...this.options.perMessageDeflate,
					isServer: true,
					maxPayload: this.options.maxPayload
				});
				try {
					const offers = extension.parse(secWebSocketExtensions);
					if (offers[PerMessageDeflate.extensionName]) {
						perMessageDeflate.accept(offers[PerMessageDeflate.extensionName]);
						extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
					}
				} catch (err) {
					abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Invalid or unacceptable Sec-WebSocket-Extensions header");
					return;
				}
			}
			if (this.options.verifyClient) {
				const info = {
					origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
					secure: !!(req.socket.authorized || req.socket.encrypted),
					req
				};
				if (this.options.verifyClient.length === 2) {
					this.options.verifyClient(info, (verified, code, message, headers) => {
						if (!verified) return abortHandshake(socket, code || 401, message, headers);
						this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
					});
					return;
				}
				if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
			}
			this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
		}
		/**
		* Upgrade the connection to WebSocket.
		*
		* @param {Object} extensions The accepted extensions
		* @param {String} key The value of the `Sec-WebSocket-Key` header
		* @param {Set} protocols The subprotocols
		* @param {http.IncomingMessage} req The request object
		* @param {Duplex} socket The network socket between the server and client
		* @param {Buffer} head The first packet of the upgraded stream
		* @param {Function} cb Callback
		* @throws {Error} If called more than once with the same socket
		* @private
		*/
		completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
			if (!socket.readable || !socket.writable) return socket.destroy();
			if (socket[kWebSocket]) throw new Error("server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration");
			if (this._state > RUNNING) return abortHandshake(socket, 503);
			const headers = [
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${createHash("sha1").update(key + GUID).digest("base64")}`
			];
			const ws = new this.options.WebSocket(null, void 0, this.options);
			if (protocols.size) {
				const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
				if (protocol) {
					headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
					ws._protocol = protocol;
				}
			}
			if (extensions[PerMessageDeflate.extensionName]) {
				const params = extensions[PerMessageDeflate.extensionName].params;
				const value = extension.format({ [PerMessageDeflate.extensionName]: [params] });
				headers.push(`Sec-WebSocket-Extensions: ${value}`);
				ws._extensions = extensions;
			}
			this.emit("headers", headers, req);
			socket.write(headers.concat("\r\n").join("\r\n"));
			socket.removeListener("error", socketOnError);
			ws.setSocket(socket, head, {
				allowSynchronousEvents: this.options.allowSynchronousEvents,
				maxBufferedChunks: this.options.maxBufferedChunks,
				maxFragments: this.options.maxFragments,
				maxPayload: this.options.maxPayload,
				skipUTF8Validation: this.options.skipUTF8Validation
			});
			if (this.clients) {
				this.clients.add(ws);
				ws.on("close", () => {
					this.clients.delete(ws);
					if (this._shouldEmitClose && !this.clients.size) process.nextTick(emitClose, this);
				});
			}
			cb(ws, req);
		}
	};
	module.exports = WebSocketServer;
	/**
	* Add event listeners on an `EventEmitter` using a map of <event, listener>
	* pairs.
	*
	* @param {EventEmitter} server The event emitter
	* @param {Object.<String, Function>} map The listeners to add
	* @return {Function} A function that will remove the added listeners when
	*     called
	* @private
	*/
	function addListeners(server, map) {
		for (const event of Object.keys(map)) server.on(event, map[event]);
		return function removeListeners() {
			for (const event of Object.keys(map)) server.removeListener(event, map[event]);
		};
	}
	/**
	* Emit a `'close'` event on an `EventEmitter`.
	*
	* @param {EventEmitter} server The event emitter
	* @private
	*/
	function emitClose(server) {
		server._state = CLOSED;
		server.emit("close");
	}
	/**
	* Handle socket errors.
	*
	* @private
	*/
	function socketOnError() {
		this.destroy();
	}
	/**
	* Close the connection when preconditions are not fulfilled.
	*
	* @param {Duplex} socket The socket of the upgrade request
	* @param {Number} code The HTTP response status code
	* @param {String} [message] The HTTP response body
	* @param {Object} [headers] Additional HTTP response headers
	* @private
	*/
	function abortHandshake(socket, code, message, headers) {
		message = message || http.STATUS_CODES[code];
		headers = {
			Connection: "close",
			"Content-Type": "text/html",
			"Content-Length": Buffer.byteLength(message),
			...headers
		};
		socket.once("finish", socket.destroy);
		socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message);
	}
	/**
	* Emit a `'wsClientError'` event on a `WebSocketServer` if there is at least
	* one listener for it, otherwise call `abortHandshake()`.
	*
	* @param {WebSocketServer} server The WebSocket server
	* @param {http.IncomingMessage} req The request object
	* @param {Duplex} socket The socket of the upgrade request
	* @param {Number} code The HTTP response status code
	* @param {String} message The HTTP response body
	* @param {Object} [headers] The HTTP response headers
	* @private
	*/
	function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
		if (server.listenerCount("wsClientError")) {
			const err = new Error(message);
			Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
			server.emit("wsClientError", err, socket, req);
		} else abortHandshake(socket, code, message, headers);
	}
}));
require_stream();
require_extension();
require_permessage_deflate();
require_receiver();
require_sender();
require_subprotocol();
var import_websocket = /* @__PURE__ */ __toESM(require_websocket(), 1);
require_websocket_server();
var wrapper_default = import_websocket.default;
// src/shared/tool-defs.mjs
/**
* MCP 工具定义的唯一来源（single source of truth）。
* 主进程 src/main/tools.ts 与 stdio 桥 cli/mcp.mjs 都从这里读取
* name / title / description / inputSchema / annotations；handler 只存在于主进程。
* 本文件为无依赖的纯 ESM，便于桥直接 import 并被 rolldown 内联。
* 修改工具 schema 时只改这里，三方一致性由 npm run check 守护。
*/
const TOOL_DEFS = [
	{
		name: "browser_navigate",
		title: "导航",
		description: "Navigate the browser to a URL in the active tab (or a new tab). Plain text that is not a URL is treated as a search query. Returns a full page snapshot after loading, so you can act immediately (pass snapshot:false to skip it if you only need browser_extract / browser_wait). For SPAs (Discourse, React apps), pass waitFor to wait until the real content is rendered; a timeout returns isError with the partial page snapshot.",
		inputSchema: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "URL or search query"
				},
				newTab: {
					type: "boolean",
					description: "Open in a new tab instead of the active one (default false)"
				},
				snapshot: {
					type: "boolean",
					description: "Include a full snapshot in the result (default true)"
				},
				waitFor: {
					type: "object",
					description: "Wait after load until one condition is met (default timeout 10000ms, max 30000ms)",
					properties: {
						selector: {
							type: "string",
							description: "Wait until this CSS selector matches a visible element (preferred for SPAs)"
						},
						text: {
							type: "string",
							description: "Wait until this text appears on the page"
						},
						urlContains: {
							type: "string",
							description: "Wait until the page URL contains this string"
						},
						timeoutMs: {
							type: "number",
							description: "Wait timeout in ms (default 10000, max 30000)"
						}
					}
				},
				tabId: {
					type: "string",
					description: "Operate on a specific tab id (from browser_tabs list)"
				}
			},
			required: ["url"]
		}
	},
	{
		name: "browser_reload",
		title: "刷新",
		description: "Reload the active tab or the tab identified by tabId. Set hard:true to bypass the cache. Returns the page URL, title, and an incremental snapshot by default.",
		inputSchema: {
			type: "object",
			properties: {
				hard: {
					type: "boolean",
					description: "Bypass the HTTP cache (default false)"
				},
				snapshot: {
					type: "boolean",
					description: "Return a snapshot after reload (default true)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_snapshot",
		title: "页面快照",
		description: "Capture a structured accessibility snapshot of the active tab as a YAML-style tree. Interactive elements carry [ref=eN] ids; pass a ref to browser_click / browser_type / browser_select_option to act on them. Snapshots are incremental: unchanged page returns a one-line reply, small changes return only the changed region, and refs stay stable across snapshots. Pass full:true to force a complete tree (automatic after navigation or large changes). For very long pages, pass maxNodes to page through the tree: the response reports totalLines and nextCursor; pass cursor on the next call. Paging still assigns refs for the whole tree, so refs from any page remain usable.",
		inputSchema: {
			type: "object",
			properties: {
				full: {
					type: "boolean",
					description: "Force a full snapshot instead of incremental (default false)"
				},
				maxNodes: {
					type: "number",
					description: "Page size: max lines to return per call (1–2000). Omit for the normal full/incremental snapshot."
				},
				cursor: {
					type: "number",
					description: "Line offset for a paged snapshot, from the previous response nextCursor (default 0)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_click",
		title: "点击",
		description: "Click an element by its snapshot ref (e.g. \"e12\"). Supports left click, right click (context menu), double click. An incremental snapshot is returned afterwards so you can see the result and continue.",
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Element ref from browser_snapshot, e.g. \"e12\""
				},
				button: {
					type: "string",
					enum: [
						"left",
						"right",
						"middle"
					],
					description: "Mouse button (default \"left\")"
				},
				doubleClick: {
					type: "boolean",
					description: "Perform double click (default false)"
				},
				snapshot: {
					type: "boolean",
					description: "Return an incremental snapshot after the action (default true)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["ref"]
		}
	},
	{
		name: "browser_drag",
		title: "拖拽",
		description: "Drag an element by ref to another element (toRef) or by a relative pixel offset (dx, dy). Useful for sliders, drag-and-drop sortable lists, and canvas boards.",
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Source element ref to drag from"
				},
				toRef: {
					type: "string",
					description: "Target element ref to drop onto"
				},
				dx: {
					type: "number",
					description: "Relative horizontal offset in pixels (e.g. 150)"
				},
				dy: {
					type: "number",
					description: "Relative vertical offset in pixels (e.g. -50)"
				},
				snapshot: {
					type: "boolean",
					description: "Return an incremental snapshot after the action (default true)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["ref"]
		}
	},
	{
		name: "browser_type",
		title: "输入文本",
		description: "Type text into a textbox/contenteditable by ref. Use submit:true to press Enter after typing (e.g. submit a search box). Use clear:true to empty the field first.",
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Element ref of the textbox"
				},
				text: {
					type: "string",
					description: "Text to type"
				},
				submit: {
					type: "boolean",
					description: "Press Enter after typing (default false)"
				},
				clear: {
					type: "boolean",
					description: "Clear the field before typing (default false)"
				},
				snapshot: {
					type: "boolean",
					description: "Return an incremental snapshot after the action (default true)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["ref", "text"]
		}
	},
	{
		name: "browser_select_option",
		title: "下拉选择",
		description: "Select an option in a <select> dropdown by ref, matching by value or visible label.",
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Element ref of the combobox"
				},
				value: {
					type: "string",
					description: "Option value to select"
				},
				label: {
					type: "string",
					description: "Option visible label to select"
				},
				snapshot: {
					type: "boolean",
					description: "Return an incremental snapshot after the action (default true)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["ref"]
		}
	},
	{
		name: "browser_scroll",
		title: "滚动页面",
		description: "Scroll the page (window first, then the largest scrollable area in the requested direction). Returns the real before/after position, didScroll, atLimit and visibilityState: a scroll that did not move the page reports didScroll:false with a reason instead of a success message. Useful before re-snapshotting content outside the viewport.",
		inputSchema: {
			type: "object",
			properties: {
				direction: {
					type: "string",
					enum: [
						"up",
						"down",
						"left",
						"right"
					],
					description: "Scroll direction"
				},
				amount: {
					type: "number",
					description: "Pixels to scroll (default 700, max 3000)"
				},
				snapshot: {
					type: "boolean",
					description: "Return an incremental snapshot after the action (default true)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["direction"]
		}
	},
	{
		name: "browser_extract",
		title: "提取文本",
		description: "Extract readable text from the page (or a specific element by ref) as plain text. Better than snapshot when you only need content, not interactive elements.",
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Extract text of this element only (default: whole page)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_page_state",
		title: "页面状态",
		description: "Read a compact page-state summary in one call: URL, title, readyState, visibilityState/hasFocus, scroll position/height/viewport (and whether the page is scrollable), visible dialogs plus intercepted alert/confirm/prompt records, Cloudflare challenge and rate-limit hints, and the browser/tab identity. Read-only. Use it before long tasks or whenever navigation or scrolling seems to have no effect.",
		inputSchema: {
			type: "object",
			properties: { tabId: {
				type: "string",
				description: "Tab id (default: active tab)"
			} }
		}
	},
	{
		name: "browser_cloudflare",
		title: "Cloudflare 验证助手",
		description: "Inspect a Cloudflare challenge that is hidden inside a cross-origin iframe, wait until the challenge settles, or (with confirm:true) send one real pointer click to a visible checkbox. This is a human-in-the-loop helper: it does not extract tokens, alter cookies, or solve sliders/images; complete those challenges yourself in the page.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"inspect",
						"click",
						"wait"
					],
					description: "Challenge operation (default inspect)"
				},
				frameId: {
					type: "string",
					description: "(click) frame id returned by inspect; omit to choose the first visible checkbox"
				},
				candidateIndex: {
					type: "number",
					description: "(click) control index returned by inspect"
				},
				confirm: {
					type: "boolean",
					description: "(click) must be true to send the real pointer event"
				},
				timeoutMs: {
					type: "number",
					description: "(wait) maximum wait in milliseconds, default 30000, max 120000"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_wait",
		title: "等待",
		description: "Wait for one of: text to appear (`text`), text to disappear (`textGone`), a selector to appear (`selector`) or disappear (`selectorGone`), the URL to contain a string (`urlContains`), or a fixed delay (`time`, ms). Multiple conditions wait for whichever happens first. Polls every 250ms. Prefer selector/urlContains on SPAs where text is reused; use text conditions for plain pages.",
		inputSchema: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "Wait until this text appears on the page"
				},
				textGone: {
					type: "string",
					description: "Wait until this text disappears from the page"
				},
				selector: {
					type: "string",
					description: "Wait until this CSS selector matches a visible element"
				},
				selectorGone: {
					type: "string",
					description: "Wait until this CSS selector matches nothing"
				},
				urlContains: {
					type: "string",
					description: "Wait until the page URL contains this string"
				},
				time: {
					type: "number",
					description: "Wait a fixed number of milliseconds (max 30000)"
				},
				timeoutMs: {
					type: "number",
					description: "Timeout in ms (default 10000, max 30000)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_press_key",
		title: "按键",
		description: "Press a key on the focused element, optionally with Ctrl/Alt/Shift/Meta modifiers. Supports Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, PageUp/PageDown, Home/End, F1-F12, a single character, or common combinations such as Ctrl+C and Ctrl+Shift+R.",
		inputSchema: {
			type: "object",
			properties: {
				key: {
					type: "string",
					description: "Key name or combination, e.g. \"Enter\", \"Escape\", \"Ctrl+C\", \"Ctrl+Shift+R\""
				},
				modifiers: {
					type: "array",
					items: {
						type: "string",
						enum: [
							"ctrl",
							"alt",
							"shift",
							"meta"
						]
					},
					description: "Optional modifier keys; equivalent to including them in key with +."
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["key"]
		}
	},
	{
		name: "browser_screenshot",
		title: "截图",
		description: "Take a PNG screenshot of the active tab, or of a specific element (pass ref — the view is scrolled to it and the image is cropped to its bounding box). Pass fullPage:true to capture the whole document (not just the viewport) — use that when reviewing long pages or comparing layout. Returns the image inline (for vision-capable models) and saves it under ~/.aabrowser/screenshots/.",
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Element ref: screenshot only this element (default: whole viewport)"
				},
				fullPage: {
					type: "boolean",
					description: "Capture the whole document instead of the viewport (max 8000px tall)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_hover",
		title: "悬停",
		description: "Hover the mouse over an element by ref (triggers hover menus, tooltips, dropdown reveals). Uses the real input path so hover-dependent UI behaves as for a human.",
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Element ref from browser_snapshot"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["ref"]
		}
	},
	{
		name: "browser_navigate_back",
		title: "后退",
		description: "Go back one page in the active tab history. Returns a fresh incremental snapshot.",
		inputSchema: {
			type: "object",
			properties: {
				snapshot: {
					type: "boolean",
					description: "Return a snapshot after navigation (default true)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_navigate_forward",
		title: "前进",
		description: "Go forward one page in the active tab history. Returns a fresh incremental snapshot.",
		inputSchema: {
			type: "object",
			properties: {
				snapshot: {
					type: "boolean",
					description: "Return a snapshot after navigation (default true)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_resize",
		title: "调整视口",
		description: "Resize the browser window content area (200–5000). Useful for responsive-design checks; then take browser_snapshot or browser_screenshot to see the adapted layout.",
		inputSchema: {
			type: "object",
			properties: {
				width: {
					type: "number",
					description: "Content width in px (200–5000)"
				},
				height: {
					type: "number",
					description: "Content height in px (200–5000)"
				}
			},
			required: ["width", "height"]
		}
	},
	{
		name: "browser_get_selector",
		title: "导出选择器",
		description: "Generate a CSS selector for a snapshot ref element (verified against the DOM). Use it to reuse the element in scripts, tests, or querySelector-based follow-up work.",
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Element ref from browser_snapshot"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["ref"]
		}
	},
	{
		name: "browser_find",
		title: "页面查找",
		description: "Find text on the page (native Ctrl+F behavior): highlights every match, scrolls to the first one and reports the match count. Keep the highlight for the user; call with browser_scroll to move on.",
		inputSchema: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "Text to find"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["text"]
		}
	},
	{
		name: "browser_cookies",
		title: "Cookie 管理",
		description: "Get / set / clear cookies of the browser session (covers all sites the session has visited). Essential for login-state testing. set requires url + name + value.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"get",
						"set",
						"clear"
					],
					description: "Operation"
				},
				url: {
					type: "string",
					description: "(get/set/clear) Cookie belongs to this URL; with clear, only cookies for this site are removed"
				},
				name: {
					type: "string",
					description: "(get: filter by name; set: cookie name; clear: only clear this name)"
				},
				value: {
					type: "string",
					description: "(set) Cookie value"
				},
				domain: {
					type: "string",
					description: "(set/clear filter) Cookie domain"
				},
				secure: {
					type: "boolean",
					description: "(set) Secure flag (default: true for https URLs)"
				},
				httpOnly: {
					type: "boolean",
					description: "(set) HttpOnly flag"
				},
				expiresSeconds: {
					type: "number",
					description: "(set) Expires in N seconds from now (omit = session cookie)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["action"]
		}
	},
	{
		name: "browser_storage",
		title: "页面存储",
		description: "Read / write / remove / clear localStorage or sessionStorage of the active page origin.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"get",
						"set",
						"remove",
						"clear"
					],
					description: "Operation (get without key = list all)"
				},
				kind: {
					type: "string",
					enum: ["local", "session"],
					description: "localStorage (default) or sessionStorage"
				},
				key: {
					type: "string",
					description: "Storage key (get without key = list all entries)"
				},
				value: {
					type: "string",
					description: "(set) Value to store"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["action"]
		}
	},
	{
		name: "browser_downloads",
		title: "下载列表",
		description: "List files captured by the browser (downloads are saved silently under ~/.aabrowser/downloads/, no save dialog). action=list (default) shows filename, source URL, size and progress/state. action=cancel stops an in-progress download; action=retry re-downloads a finished one into a new -r file (URL is re-validated against the site allowlist).",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"list",
						"cancel",
						"retry"
					],
					description: "Download operation (default list)"
				},
				id: {
					type: "string",
					description: "(cancel/retry) download id from action=list"
				},
				limit: {
					type: "number",
					description: "(list) Max entries (default 20, newest last)"
				}
			}
		}
	},
	{
		name: "browser_pdf",
		title: "存为 PDF",
		description: "Render the active page to a PDF (A4, print background on) and save it. Returns the file path.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Output file path inside the browser export dirs (~/.aabrowser/downloads, har, screenshots or AA_BROWSER_EXPORT_DIR; default ~/.aabrowser/downloads/aa-page-<ts>.pdf). Symlinks and paths outside those dirs are rejected."
				},
				landscape: {
					type: "boolean",
					description: "Landscape orientation (default false)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_upload_file",
		title: "上传文件",
		description: "Upload local file(s) into a <input type=file> element by ref. Accepts absolute local paths; total size capped at 20MB. Fire-and-forget is enough — the change event fires for the page.",
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Element ref of the file input"
				},
				paths: {
					type: "array",
					items: { type: "string" },
					description: "Absolute local file path(s)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["ref", "paths"]
		}
	},
	{
		name: "browser_console",
		title: "控制台日志",
		description: "Read recent console messages of the active tab (useful for debugging pages).",
		inputSchema: {
			type: "object",
			properties: {
				level: {
					type: "string",
					enum: [
						"all",
						"info",
						"warning",
						"error"
					],
					description: "Filter level (default all)"
				},
				limit: {
					type: "number",
					description: "Max entries (default 50)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_performance",
		title: "页面性能摘要",
		description: "Summarize performance metrics of the active tab: navigation timing (TTFB / DOMContentLoaded / load), First Contentful Paint, resource count and transfer size, slowest resources, JS heap usage and DOM size. Read-only diagnostics for slow pages; no DevTools needed.",
		inputSchema: {
			type: "object",
			properties: {
				slowest: {
					type: "number",
					description: "How many slowest resources to list (default 5, max 20)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_network_requests",
		title: "网络请求列表（抓包）",
		description: "List captured network requests of the active tab (HTTP-level packet capture): id, method, status, type, size, duration, URL. Capture starts automatically on first use. Use browser_network_detail with a request id to inspect headers and response body.",
		inputSchema: {
			type: "object",
			properties: {
				urlContains: {
					type: "string",
					description: "Only requests whose URL contains this (case-insensitive)"
				},
				method: {
					type: "string",
					description: "Filter by HTTP method, e.g. GET/POST"
				},
				statusMin: {
					type: "number",
					description: "Minimum HTTP status (e.g. 400 for errors)"
				},
				statusMax: {
					type: "number",
					description: "Maximum HTTP status"
				},
				resourceType: {
					type: "string",
					description: "Filter by type: Document/Script/XHR/Fetch/Image/Stylesheet/…"
				},
				limit: {
					type: "number",
					description: "Max entries (default 50, newest last)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_network_detail",
		title: "网络请求详情",
		description: "Inspect one captured network request: headers, status, size, duration, and (with body:true) the response body text. Authentication headers, credential-like URL parameters, and recognized sensitive fields in JSON/text bodies are redacted by default; response bodies are capped before crossing the MCP boundary. Pass includeSensitive:true only when needed.",
		inputSchema: {
			type: "object",
			properties: {
				requestId: {
					type: "string",
					description: "Request id from browser_network_requests, e.g. \"1234.5\""
				},
				body: {
					type: "boolean",
					description: "Include the response body (default false)"
				},
				includeSensitive: {
					type: "boolean",
					description: "Include authentication headers and credential-like URL parameters (default false; use only when needed)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["requestId"]
		}
	},
	{
		name: "browser_har",
		title: "导出 HAR",
		description: "Export captured network traffic as HAR 1.2 (no response bodies). Authentication headers and credential-like URL parameters are redacted by default; pass includeSensitive:true only when needed.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Output file path inside the browser export dirs (~/.aabrowser/downloads, har, screenshots or AA_BROWSER_EXPORT_DIR; default ~/.aabrowser/har/aa-<timestamp>.har). Symlinks and paths outside those dirs are rejected."
				},
				includeSensitive: {
					type: "boolean",
					description: "Include authentication headers and credential-like URL parameters (default false; handle the exported file as sensitive)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_mock_requests",
		title: "请求拦截 Mock",
		description: "Intercept and mock HTTP requests of the active tab. Add or replace a rule that matches a URL substring (and optional method); matched requests are answered with a fake status/headers/body instead of reaching the network. Use to simulate API responses, error states, or stub third-party calls during testing. Pass action:\"continue\" to just observe (log) a matching request without answering it. Returns the rule id and current rules.",
		inputSchema: {
			type: "object",
			properties: {
				urlContains: {
					type: "string",
					description: "Substring of request URL to match (case-insensitive), e.g. \"/api/v1/quote\""
				},
				method: {
					type: "string",
					description: "Only mock this HTTP method (e.g. GET/POST). Omit to match any."
				},
				status: {
					type: "number",
					description: "Fake response status code (default 200)"
				},
				headers: {
					type: "object",
					description: "Fake response headers (optional)"
				},
				body: {
					type: "string",
					description: "Fake response body text (default empty)"
				},
				action: {
					type: "string",
					enum: ["respond", "continue"],
					description: "respond=answer with mock (default); continue=just pass through"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["urlContains"]
		}
	},
	{
		name: "browser_list_mocks",
		title: "列出 Mock 规则",
		description: "List all active request-mock rules of the active tab (id, matcher, status, hits).",
		inputSchema: {
			type: "object",
			properties: { tabId: {
				type: "string",
				description: "Tab id (default: active tab)"
			} }
		}
	},
	{
		name: "browser_clear_mocks",
		title: "清空 Mock 规则",
		description: "Remove all (or one, by rule id) request-mock rules of the active tab and stop intercepting. Pass id to remove a single rule. Returns how many were removed.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Rule id to remove (omit to clear all)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_fill_form",
		title: "批量填写表单",
		description: "Fill multiple form fields in one call instead of one browser_type per field. Each item takes a ref plus either `value` (text input / select option value), `label` (select by visible label), or `checked` (checkbox / radio). Fields are filled in order and the resulting snapshot is returned once at the end, which makes multi-field forms far cheaper than repeated single-field calls.",
		inputSchema: {
			type: "object",
			properties: {
				fields: {
					type: "array",
					description: "Fields to fill, in order",
					items: {
						type: "object",
						properties: {
							ref: {
								type: "string",
								description: "Element ref"
							},
							value: {
								type: "string",
								description: "Text to type, or option value for a <select>"
							},
							label: {
								type: "string",
								description: "Option visible label for a <select>"
							},
							checked: {
								type: "boolean",
								description: "Desired checked state for checkbox/radio"
							},
							submit: {
								type: "boolean",
								description: "Press Enter after typing this field (default false)"
							}
						},
						required: ["ref"]
					}
				},
				snapshot: {
					type: "boolean",
					description: "Return an incremental snapshot after all fields (default true)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["fields"]
		}
	},
	{
		name: "browser_evaluate",
		title: "执行 JavaScript",
		description: "Evaluate a JavaScript expression in the page (or on a specific element by ref) and return the result as JSON. Runs in the page main world. Use for values not exposed by snapshot/extract, e.g. reading a computed style or a JS variable. The expression must be a single expression or IIFE.",
		inputSchema: {
			type: "object",
			properties: {
				expression: {
					type: "string",
					description: "JavaScript expression to evaluate, e.g. \"document.title\" or \"(() => {...})()\""
				},
				ref: {
					type: "string",
					description: "Element ref to bind as the `element` variable (optional)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["expression"]
		}
	},
	{
		name: "browser_dialogs",
		title: "页面对话框记录",
		description: "Read (and optionally clear) dialogs the page tried to open — alert / confirm / prompt. Dialogs are intercepted instead of blocking: by default confirm returns false and prompt returns null. Use browser_dialog_respond first to choose what confirm/prompt return, then click the control that triggers them. Use this tool to detect \"are you sure?\" style interruptions without stalling the automation.",
		inputSchema: {
			type: "object",
			properties: {
				clear: {
					type: "boolean",
					description: "Clear the recorded list after reading (default false)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_dialog_respond",
		title: "对话框应答策略",
		description: "Decide what the next (or every following) window.confirm / window.prompt returns, so flows that need confirmation or text input can be tested. Set confirm:true to accept, confirm:false to cancel, prompt:\"text\" to answer a prompt (prompt with no value returns null). Default is once:true — the policy is consumed by the next dialog; pass once:false to keep it. Pass reset:true to clear the policy.",
		inputSchema: {
			type: "object",
			properties: {
				confirm: {
					type: "boolean",
					description: "What window.confirm returns (true = accept, false = cancel)"
				},
				prompt: {
					type: "string",
					description: "What window.prompt returns as the entered text"
				},
				once: {
					type: "boolean",
					description: "Consume the policy after the next dialog (default true)"
				},
				reset: {
					type: "boolean",
					description: "Clear any policy and restore the default (confirm→false, prompt→null)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_assert",
		title: "断言校验",
		description: "Verify that what you just did actually worked. Pass one or more checks; each is reported as passed or failed with expected vs actual, and the tool returns isError when any check fails — that is how you distinguish \"the click happened\" from \"the feature works\". Supported kinds: url, title, text, selector, count, value, checked, attribute, console, network. match defaults to contains for text-like kinds, equals for count/console, and exists for selector. Use this after every meaningful step of a website test.",
		inputSchema: {
			type: "object",
			properties: {
				checks: {
					type: "array",
					description: "Assertions to verify, evaluated in order",
					items: {
						type: "object",
						properties: {
							kind: {
								type: "string",
								enum: [
									"url",
									"title",
									"text",
									"selector",
									"count",
									"value",
									"checked",
									"attribute",
									"console",
									"network"
								],
								description: "What to check"
							},
							target: {
								type: "string",
								description: "CSS selector or snapshot ref (e.g. e12) for selector/count/value/checked/attribute"
							},
							match: {
								type: "string",
								enum: [
									"equals",
									"contains",
									"notContains",
									"regex",
									"gte",
									"lte",
									"exists",
									"absent"
								],
								description: "Comparison mode (default depends on kind)"
							},
							expected: { description: "Expected value: string, number (count/console) or boolean (checked)" },
							message: {
								type: "string",
								description: "Human-readable label shown in the result"
							},
							attribute: {
								type: "string",
								description: "(attribute) attribute name"
							},
							level: {
								type: "string",
								enum: [
									"error",
									"warning",
									"all"
								],
								description: "(console) level filter, default error"
							},
							since: {
								type: "number",
								description: "(console) only logs after this Unix ms timestamp"
							},
							urlContains: {
								type: "string",
								description: "(network) request URL substring"
							},
							method: {
								type: "string",
								description: "(network) HTTP method filter"
							},
							status: {
								type: "number",
								description: "(network) exact status code required"
							},
							statusMin: {
								type: "number",
								description: "(network) minimum status"
							},
							statusMax: {
								type: "number",
								description: "(network) maximum status"
							}
						},
						required: ["kind"]
					}
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["checks"]
		}
	},
	{
		name: "browser_frame",
		title: "iframe 操作",
		description: "Operate inside any frame, including cross-origin iframes that browser_snapshot cannot see into (payment widgets, OAuth, embedded editors, third-party chat). action=list shows every frame with its id, URL and whether it is cross-origin. action=text reads that frame text, action=elements lists interactive elements with usable CSS selectors, action=evaluate runs an expression inside the frame, and action=click/type/select act on a CSS selector inside the frame. Always start with action=list.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"list",
						"text",
						"elements",
						"evaluate",
						"click",
						"type",
						"select"
					],
					description: "Frame operation"
				},
				frameId: {
					type: "string",
					description: "Frame id from action=list, e.g. \"f3\""
				},
				selector: {
					type: "string",
					description: "(click/type/select) CSS selector inside that frame"
				},
				expression: {
					type: "string",
					description: "(evaluate) JavaScript expression evaluated inside the frame"
				},
				text: {
					type: "string",
					description: "(type) text to enter"
				},
				value: {
					type: "string",
					description: "(select) option value"
				},
				label: {
					type: "string",
					description: "(select) option visible label"
				},
				index: {
					type: "number",
					description: "(click) which match to click, 0-based (default 0)"
				},
				maxChars: {
					type: "number",
					description: "(text) max characters to return (default 4000)"
				},
				limit: {
					type: "number",
					description: "(elements) max elements to list (default 80)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["action"]
		}
	},
	{
		name: "browser_tabs",
		title: "标签管理",
		description: "Manage this MCP client’s tabs: \"list\" shows only tabs owned by this client (the first operation may claim the current unowned tab); \"new\" opens an owned tab without switching the user’s visible tab; \"select\" changes this client’s default tab (pass bringToFront:true only when intentionally switching the shared visible browser); \"close\" closes an owned tab. Tabs share the browser session (cookies/logins) unless created with isolated:true, which uses a throwaway partition cleared on close.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"list",
						"new",
						"select",
						"close"
					],
					description: "Tab operation"
				},
				url: {
					type: "string",
					description: "(action=new) URL to open"
				},
				isolated: {
					type: "boolean",
					description: "(action=new) Use a throwaway session partition instead of the shared one (default: settings)"
				},
				tabId: {
					type: "string",
					description: "(action=select/close) target tab id"
				},
				bringToFront: {
					type: "boolean",
					description: "(action=select) Also restore/show the browser window and focus the page (default false: only switches the active tab)"
				}
			},
			required: ["action"]
		}
	},
	{
		name: "browser_window",
		title: "后台窗口与实时预览",
		description: "Control the real Electron window mode without changing the browser profile: visible (normal foreground), background (shown without taking focus), minimized, hidden, or background-visual (background operation with an independent live preview). action=mode gets or sets the mode; action=monitor starts/stops preview for one explicit tab; action=takeover locks AI input for human control; action=release hands control back to AI. The preview captures only the selected tab and keeps a bounded screenshot history.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"mode",
						"monitor",
						"takeover",
						"release"
					],
					description: "Window/monitor operation"
				},
				mode: {
					type: "string",
					enum: [
						"visible",
						"background",
						"minimized",
						"hidden",
						"background-visual"
					],
					description: "(action=mode) real Electron window mode"
				},
				monitor: {
					type: "boolean",
					description: "(action=mode) also start/stop the independent preview"
				},
				tabId: {
					type: "string",
					description: "(action=monitor) tab to preview; defaults to the active tab"
				}
			},
			required: ["action"]
		}
	},
	{
		name: "browser_tasks",
		title: "后台任务中心",
		description: "Inspect tasks and recent execution logs scoped to the calling MCP client. action=list returns that client’s active calls and bounded history; action=cancel stops one owned call; action=pause/resume only affects the calling client. The browser UI can pause all clients, and browser_window takeover locks the shared browser for human control with a live preview.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"list",
						"cancel",
						"pause",
						"resume"
					],
					description: "Task operation"
				},
				id: {
					type: "number",
					description: "(action=cancel) MCP call id"
				},
				client: {
					type: "number",
					description: "(action=cancel) optional client number; must match the calling MCP client"
				}
			},
			required: ["action"]
		}
	},
	{
		name: "browser_visual_diff",
		title: "视觉基线对比",
		description: "Visual regression loop for UI review. action=save stores the current page screenshot as a named baseline (under ~/.aabrowser/baselines/, override with AA_BROWSER_BASELINE_DIR); action=compare captures again and returns a pixel-level diff (changed pixels, percent, bounding box, mean/max channel difference) plus a red diff image path. compare returns isError when the change exceeds maxDiffPercent, so it can be used as a visual assertion. action=list shows baselines; action=delete removes one. Use fullPage:true for long pages.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"save",
						"compare",
						"list",
						"delete"
					],
					description: "Baseline operation"
				},
				name: {
					type: "string",
					description: "Baseline name: letters/digits/dot/underscore/hyphen, max 80 chars"
				},
				fullPage: {
					type: "boolean",
					description: "Capture the whole document instead of the viewport (default false)"
				},
				pixelThreshold: {
					type: "number",
					description: "Per-channel difference that counts as a changed pixel (0–255, default 16)"
				},
				maxDiffPercent: {
					type: "number",
					description: "Fail the comparison when changed pixels exceed this percent (default 0.5)"
				},
				writeDiff: {
					type: "boolean",
					description: "Write a red-highlighted diff PNG (default true)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			},
			required: ["action"]
		}
	},
	{
		name: "browser_contrast_audit",
		title: "对比度审计",
		description: "Audit WCAG text contrast on the current page. Reads computed foreground/background colors of visible text elements (compositing alpha over ancestors), computes contrast ratio and flags AA (4.5:1 / 3:1 large) or AAA (7:1 / 4.5:1 large) violations with a CSS selector and text snippet. Use this to find unreadable text before shipping. Returns isError when violations exist unless failOnViolation:false.",
		inputSchema: {
			type: "object",
			properties: {
				level: {
					type: "string",
					enum: ["AA", "AAA"],
					description: "WCAG conformance level (default AA)"
				},
				maxResults: {
					type: "number",
					description: "Max violations to report (1–200, default 50)"
				},
				failOnViolation: {
					type: "boolean",
					description: "Return isError when violations exist (default true)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_viewport_matrix",
		title: "多视口矩阵",
		description: "Capture the same page at multiple viewport sizes and DPI scales in one call — use it for responsive-design review. Uses CDP device-metrics emulation, so it can render real 320/480/768px viewports and 2x high-DPI even though the BrowserWindow itself has a 960×640 minimum; the override is always cleared afterwards. Each entry reports actual PNG pixels and horizontal overflow. preset defaults to all; pass viewports to define exact sizes. Screenshots are saved under ~/.aabrowser/screenshots/.",
		inputSchema: {
			type: "object",
			properties: {
				preset: {
					type: "string",
					enum: [
						"mobile",
						"tablet",
						"desktop",
						"hi-dpi",
						"all"
					],
					description: "Viewport preset (default all)"
				},
				viewports: {
					type: "array",
					description: "Explicit viewport list; overrides preset. Max 12 entries.",
					items: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "Short label (letters/digits/_/-)"
							},
							width: {
								type: "number",
								description: "CSS width in px (200–5000)"
							},
							height: {
								type: "number",
								description: "CSS height in px (200–5000)"
							},
							deviceScaleFactor: {
								type: "number",
								description: "DPI scale 1–4 (default 1)"
							},
							mobile: {
								type: "boolean",
								description: "Emulate mobile viewport (default false)"
							}
						},
						required: ["width", "height"]
					}
				},
				includeImages: {
					type: "boolean",
					description: "Attach up to 4 screenshots as image blocks in the result (default false)"
				},
				tabId: {
					type: "string",
					description: "Tab id (default: active tab)"
				}
			}
		}
	},
	{
		name: "browser_extensions",
		title: "浏览器扩展",
		description: "Manage unpacked (Load unpacked) Chrome extensions. action=list shows loaded extensions (id, name, version, manifest version, local path); action=load loads an unpacked extension from an absolute directory path that contains manifest.json (persisted, reloaded on browser restart, injected into the shared session; isolated tabs do not get extensions); action=remove unloads one by path or extension id and removes it from the persisted list. Extensions take effect for new page loads — reload the tab after loading one.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"list",
						"load",
						"remove"
					],
					description: "Extension operation (default list)"
				},
				path: {
					type: "string",
					description: "(load) absolute directory containing manifest.json; (remove) alternative to id"
				},
				id: {
					type: "string",
					description: "(remove) extension id from action=list"
				}
			}
		}
	},
	{
		name: "browser_evidence",
		title: "证据文件管理",
		description: "Inspect and maintain generated evidence files (screenshots, viewport PNGs, HAR, PDF, visual baselines/diffs, context-menu shots). action=list shows registered files with sha256, size, TTL and age; action=sweep deletes expired or over-quota temporary evidence (baselines/downloads are preserved); action=hash computes a file sha256; action=forget removes a registry entry without deleting the file. Registry path can be overridden with AA_BROWSER_EVIDENCE_FILE.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"list",
						"sweep",
						"hash",
						"forget"
					],
					description: "Evidence operation (default list)"
				},
				file: {
					type: "string",
					description: "(hash/forget) absolute file path"
				},
				limit: {
					type: "number",
					description: "(list) max entries, default 50"
				}
			}
		}
	}
];
const TOOL_ANNOTATIONS = Object.freeze({
	browser_navigate: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_reload: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_snapshot: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_click: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_drag: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_type: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_select_option: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_scroll: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_extract: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_page_state: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_cloudflare: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_wait: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_press_key: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_screenshot: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_hover: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_navigate_back: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_navigate_forward: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_resize: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false
	},
	browser_get_selector: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_find: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_cookies: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_storage: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_downloads: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	browser_pdf: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_upload_file: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_console: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_performance: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_network_requests: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_network_detail: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_har: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_mock_requests: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_list_mocks: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false
	},
	browser_clear_mocks: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false
	},
	browser_tabs: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_window: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false
	},
	browser_tasks: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	browser_fill_form: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_dialogs: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_dialog_respond: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false
	},
	browser_frame: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_assert: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_evaluate: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	browser_visual_diff: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	browser_contrast_audit: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	},
	browser_viewport_matrix: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false
	},
	browser_extensions: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	browser_evidence: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	}
});
// cli/mcp.mjs
/**
* aa-browser-mcp —— MCP stdio 桥。
*
* 把 MCP（stdio 上的 JSON-RPC）连接转发到 Aa Browser 桌面应用
* （通过 ~/.aabrowser/connection.json 发现，未运行时首次工具调用会按受信路径自动启动，走本地 WebSocket）。
*
* 协议：MCP stdio 为换行分隔的 JSON-RPC 2.0。实现最小子集：
*   initialize / notifications/* / tools/list / tools/call / ping
* 零依赖，直接 `node cli/mcp.mjs` 运行。
*/
/**
* 版本号单一来源：优先使用构建期注入的 package.json 版本；
* 源码直接运行时回退到逐级查找 package.json。
* 构建产物 out/bridge/mcp.cjs 位于 <root>/out/bridge/，源码位于 <root>/cli/。
*
* ⚠️ 注入走 globalThis 动态属性，而不是"常量与字面量比较"：
* 打包器会把 `X !== '0.0.0-dev'` 这种常量比较直接折叠掉，
* 连注入点一起删除，构建期就再也找不到可替换的位置。
*/
function readVersion() {
	try {
		const injected = globalThis.__AA_BRIDGE_VERSION__;
		if (typeof injected === "string" && injected) return injected;
	} catch {}
	let dir = node_path.default.dirname((0, node_url.fileURLToPath)(require("url").pathToFileURL(__filename).href));
	for (let i = 0; i < 5; i++) {
		try {
			const pkg = JSON.parse(node_fs.default.readFileSync(node_path.default.join(dir, "package.json"), "utf-8"));
			if (pkg?.name === "aa-browser" && typeof pkg.version === "string") return pkg.version;
		} catch {}
		const up = node_path.default.dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return "0.0.0";
}
const VERSION = readVersion();
const CLIENT_SESSION_ID = (0, node_crypto.randomUUID)();
const CONNECT_FILE = node_process.default.env["AA_BROWSER_CONNECTION_FILE"] || node_path.default.join(node_os.default.homedir(), ".aabrowser", "connection.json");
/**
* 必须大于主进程的审批等待窗口（ApprovalManager 默认 120s），
* 否则用户还在审批时桥已超时并发出 cancel，审批结果永远无法送达。
*/
const CALL_TIMEOUT_MS = 18e4;
const log = (...a) => console.error("[aa-browser-mcp]", ...a);
for (const tool of TOOL_DEFS) {
	const annotations = TOOL_ANNOTATIONS[tool.name];
	if (!annotations || Object.keys(annotations).length !== 4 || Object.values(annotations).some((value) => typeof value !== "boolean")) throw new Error(`工具缺少完整 MCP annotations：${tool.name}`);
}
let ws = null;
let connecting = null;
let suspendedReconnect = null;
let nextCallId = 1;
const pending = /* @__PURE__ */ new Map();
/** 断线后等待重连再重发的只读调用；写操作绝不进入这里。 */
const suspended = /* @__PURE__ */ new Set();
const mcpToBridge = /* @__PURE__ */ new Map();
const cancelledMcpRequests = /* @__PURE__ */ new Set();
const bridgeToProgressToken = /* @__PURE__ */ new Map();
/**
* 只有「只读 + 幂等」的调用才允许跨重启自动重发：
* 应用更新会重启进程，重发读取不会改变页面；点击、输入、表单提交等
* 可能已部分执行，重放会造成二次副作用，因此只回报明确的中断错误。
*/
const RETRYABLE_TOOLS = new Set(TOOL_DEFS.filter((tool) => TOOL_ANNOTATIONS[tool.name]?.readOnlyHint === true && TOOL_ANNOTATIONS[tool.name]?.idempotentHint === true).map((tool) => tool.name));
const RETRY_ON_RECONNECT = node_process.default.env["AA_BROWSER_RETRY_ON_RECONNECT"] !== "0";
function isRetryable(name, args) {
	if (!RETRY_ON_RECONNECT) return false;
	if (name === "browser_tabs") return args?.action === "list";
	return RETRYABLE_TOOLS.has(name);
}
function readConnection() {
	try {
		const info = JSON.parse(node_fs.default.readFileSync(CONNECT_FILE, "utf-8"));
		if (!info.port || !info.token) throw new Error("invalid");
		return info;
	} catch {
		return null;
	}
}
/**
* 更新重启标记：应用在 quitAndInstall 前写入，重启后的新实例清除。
* 看到标记说明「旧实例已退出、安装器/新实例还没就绪」，此时不能自动启动，
* 否则会和安装器抢文件或拉起一个旧版本。
*/
const RESTART_MARKER = node_path.default.join(node_path.default.dirname(CONNECT_FILE), "update-restart.json");
const RESTART_MARKER_TTL_MS = 6e5;
const UPDATE_RESTART_TIMEOUT_MS = Math.min(CALL_TIMEOUT_MS, Math.max(5e3, Number(node_process.default.env["AA_BROWSER_RESTART_TIMEOUT_MS"]) || 12e4));
function updateRestartPending() {
	try {
		const marker = JSON.parse(node_fs.default.readFileSync(RESTART_MARKER, "utf-8"));
		if (marker?.reason !== "update" || typeof marker.at !== "number") return false;
		const age = Date.now() - marker.at;
		return age >= -6e4 && age <= RESTART_MARKER_TTL_MS;
	} catch {
		return false;
	}
}
function isPidAlive(pid) {
	try {
		node_process.default.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
const AUTO_LAUNCH_TIMEOUT_MS = Math.min(12e4, Math.max(5e3, Number(node_process.default.env["AA_BROWSER_LAUNCH_TIMEOUT_MS"]) || 3e4));
const CONNECT_RETRY_MS = Math.min(2e3, Math.max(100, Number(node_process.default.env["AA_BROWSER_CONNECT_RETRY_MS"]) || 500));
let launchPromise = null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function isRegularFile(file) {
	try {
		return node_fs.default.statSync(file).isFile();
	} catch {
		return false;
	}
}
function addPathCandidate(list, value) {
	if (!value || !node_path.default.isAbsolute(value)) return;
	const resolved = node_path.default.resolve(value);
	if (!list.includes(resolved)) list.push(resolved);
}
function browserLaunchSpec() {
	const candidates = [];
	const explicit = node_process.default.env["AA_BROWSER_APP_PATH"]?.trim();
	if (explicit) {
		if (!node_path.default.isAbsolute(explicit)) throw new Error("AA_BROWSER_APP_PATH 必须是绝对路径。");
		const file = node_path.default.resolve(explicit);
		if (!(node_process.default.platform === "win32" ? /^(Aa Browser|aa-browser)\.exe$/i : node_process.default.platform === "linux" ? /^(?:AppRun|AaBrowser\.AppImage|(?:Aa Browser|aa-browser)(?:\.AppImage|-[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?\.AppImage)?)$/i : /^(Aa Browser|aa-browser)$/i).test(node_path.default.basename(file)) || !isRegularFile(file)) throw new Error("AA_BROWSER_APP_PATH 不是受支持的 Aa Browser 可执行文件。");
		return {
			command: file,
			args: [],
			cwd: node_path.default.dirname(file)
		};
	}
	const bridgeDir = node_path.default.dirname(node_path.default.resolve((0, node_url.fileURLToPath)(require("url").pathToFileURL(__filename).href)));
	const installRoot = node_path.default.resolve(bridgeDir, "../../../..");
	if (node_fs.default.existsSync(node_path.default.join(installRoot, "resources", "app.asar.unpacked"))) {
		addPathCandidate(candidates, node_path.default.join(installRoot, node_process.default.platform === "win32" ? "Aa Browser.exe" : "aa-browser"));
		if (node_process.default.platform === "linux") {
			addPathCandidate(candidates, node_path.default.join(installRoot, "Aa Browser"));
			addPathCandidate(candidates, node_path.default.join(installRoot, "usr", "bin", "aa-browser"));
			addPathCandidate(candidates, node_path.default.join(installRoot, "AppRun"));
		}
	}
	if (node_process.default.platform === "win32") {
		const localAppData = node_process.default.env["LOCALAPPDATA"];
		const programFiles = node_process.default.env["PROGRAMFILES"];
		const programFilesX86 = node_process.default.env["PROGRAMFILES(X86)"];
		for (const dir of [
			localAppData && node_path.default.join(localAppData, "Programs", "Aa Browser"),
			programFiles && node_path.default.join(programFiles, "Aa Browser"),
			programFilesX86 && node_path.default.join(programFilesX86, "Aa Browser")
		]) addPathCandidate(candidates, dir && node_path.default.join(dir, "Aa Browser.exe"));
	} else if (node_process.default.platform === "darwin") {
		addPathCandidate(candidates, "/Applications/Aa Browser.app/Contents/MacOS/Aa Browser");
		addPathCandidate(candidates, node_path.default.join(node_os.default.homedir(), "Applications", "Aa Browser.app", "Contents", "MacOS", "Aa Browser"));
	} else {
		addPathCandidate(candidates, "/usr/bin/aa-browser");
		addPathCandidate(candidates, "/usr/local/bin/aa-browser");
		addPathCandidate(candidates, "/opt/Aa Browser/aa-browser");
		addPathCandidate(candidates, node_path.default.join(node_os.default.homedir(), ".local", "bin", "aa-browser"));
		if (node_process.default.platform === "linux") addPathCandidate(candidates, node_path.default.join(node_os.default.homedir(), "Applications", "AaBrowser.AppImage"));
	}
	let sourceSpec = null;
	let sourceRoot = bridgeDir;
	for (let i = 0; i < 6; i++) {
		try {
			if (JSON.parse(node_fs.default.readFileSync(node_path.default.join(sourceRoot, "package.json"), "utf8"))?.name === "aa-browser") {
				const electronBinary = node_process.default.platform === "win32" ? node_path.default.join(sourceRoot, "node_modules", "electron", "dist", "electron.exe") : node_process.default.platform === "darwin" ? node_path.default.join(sourceRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron") : node_path.default.join(sourceRoot, "node_modules", "electron", "dist", "electron");
				if (isRegularFile(electronBinary)) sourceSpec = {
					command: electronBinary,
					args: [sourceRoot],
					cwd: sourceRoot
				};
				break;
			}
		} catch {}
		const parent = node_path.default.dirname(sourceRoot);
		if (parent === sourceRoot) break;
		sourceRoot = parent;
	}
	const file = candidates.find((candidate) => isRegularFile(candidate));
	if (file) return {
		command: file,
		args: [],
		cwd: node_path.default.dirname(file)
	};
	return sourceSpec;
}
function connectionReady() {
	const info = readConnection();
	return !!info && isPidAlive(info.pid);
}
async function waitForConnection() {
	const deadline = Date.now() + AUTO_LAUNCH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (connectionReady()) return;
		await delay(CONNECT_RETRY_MS);
	}
	throw new Error(`Aa Browser 已启动但在 ${Math.round(AUTO_LAUNCH_TIMEOUT_MS / 1e3)} 秒内没有写入连接信息。`);
}
async function ensureBrowserStarted() {
	if (node_process.default.env["AA_BROWSER_AUTO_LAUNCH"] === "0" || node_process.default.env["AA_BROWSER_AUTO_LAUNCH"]?.toLowerCase() === "false") throw new Error("Aa Browser 未运行，且已通过 AA_BROWSER_AUTO_LAUNCH 禁用自动启动。");
	if (connectionReady()) return;
	if (launchPromise) return launchPromise;
	launchPromise = (async () => {
		const spec = browserLaunchSpec();
		if (!spec) throw new Error("未找到可启动的 Aa Browser。请安装桌面应用，或设置 AA_BROWSER_APP_PATH 指向 Aa Browser.exe/aa-browser。");
		log("Aa Browser 未运行，正在自动启动…");
		await new Promise((resolve, reject) => {
			let settled = false;
			const launchEnv = {
				...node_process.default.env,
				AA_BROWSER_CONNECTION_FILE: CONNECT_FILE,
				AA_BROWSER_START_IN_BACKGROUND: "1"
			};
			delete launchEnv.ELECTRON_RUN_AS_NODE;
			const child = (0, node_child_process.spawn)(spec.command, spec.args, {
				cwd: spec.cwd,
				env: launchEnv,
				detached: false,
				stdio: "ignore",
				windowsHide: true
			});
			child.once("error", (error) => {
				if (!settled) {
					settled = true;
					reject(/* @__PURE__ */ new Error(`自动启动 Aa Browser 失败：${error.message}`));
				}
			});
			child.once("spawn", () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			});
			child.unref();
		});
		await waitForConnection();
		log("Aa Browser 已启动，等待 MCP 连接就绪");
	})().finally(() => {
		launchPromise = null;
	});
	return launchPromise;
}
/** 清除一条调用的所有索引；调用方随后决定 resolve / reject。 */
function detachPending(p) {
	clearTimeout(p.timer);
	if (p.id !== null) {
		pending.delete(p.id);
		bridgeToProgressToken.delete(p.id);
	}
	suspended.delete(p);
	if (p.mcpId !== void 0 && (mcpToBridge.get(p.mcpId) === p.id || mcpToBridge.get(p.mcpId) === -2)) mcpToBridge.delete(p.mcpId);
}
function rejectPending(p, error) {
	detachPending(p);
	p.reject(error);
}
/** 发送（首次或重连后重发）；成功回包由 socket message 处理。 */
function sendPending(p, socket) {
	suspended.delete(p);
	const id = nextCallId++;
	p.id = id;
	p.socket = socket;
	pending.set(id, p);
	if (p.mcpId !== void 0) mcpToBridge.set(p.mcpId, id);
	if (p.progressToken !== void 0) bridgeToProgressToken.set(id, p.progressToken);
	const request = {
		id,
		tool: p.name,
		args: p.args
	};
	if (p.progressToken !== void 0) request.progressToken = p.progressToken;
	const failSend = (error) => {
		if (!error || pending.get(id) !== p) return;
		rejectPending(p, error);
	};
	try {
		if (socket.readyState !== wrapper_default.OPEN) throw new Error("与 Aa Browser 的连接已断开。");
		socket.send(JSON.stringify(request), failSend);
	} catch (error) {
		failSend(error);
	}
}
/** 新实例连上后，把等待中的只读调用按新 id 重发。 */
function flushSuspended(socket) {
	if (!suspended.size || socket.readyState !== wrapper_default.OPEN) return;
	const queue = [...suspended];
	suspended.clear();
	for (const p of queue) {
		if (pending.get(p.id) === p) continue;
		log("replaying read-only call after browser restart:", p.name);
		sendPending(p, socket);
	}
}
/**
* 断线后主动恢复，避免只读调用干等到 5 秒的 eager 轮询。
* 走 getWs()：更新重启时它会识别标记、只等待新实例；普通退出/崩溃时
* 沿用原有的自动启动行为，把浏览器带回来完成这次读取。
*/
function scheduleSuspendedReconnect() {
	if (suspendedReconnect || !suspended.size) return;
	suspendedReconnect = (async () => {
		const deadline = Date.now() + UPDATE_RESTART_TIMEOUT_MS;
		while (suspended.size && Date.now() < deadline) {
			if (ws && ws.readyState === wrapper_default.OPEN) {
				flushSuspended(ws);
				break;
			}
			try {
				await getWs();
				if (ws && ws.readyState === wrapper_default.OPEN) {
					flushSuspended(ws);
					break;
				}
			} catch {}
			await delay(CONNECT_RETRY_MS);
		}
	})().finally(() => {
		suspendedReconnect = null;
	});
}
function connectWs() {
	if (ws && ws.readyState === wrapper_default.OPEN) return Promise.resolve(ws);
	if (connecting) return connecting;
	const attempt = new Promise((resolve, reject) => {
		const info = readConnection();
		if (!info) {
			reject(/* @__PURE__ */ new Error("未找到 Aa Browser：请先启动 Aa Browser 桌面应用（npm run dev 或 npm start）。"));
			return;
		}
		if (!isPidAlive(info.pid)) {
			reject(/* @__PURE__ */ new Error("Aa Browser 进程已退出但发现文件残留：请重新启动 Aa Browser。"));
			return;
		}
		const endpoint = new URL(`ws://127.0.0.1:${info.port}/`);
		endpoint.searchParams.set("token", info.token);
		endpoint.searchParams.set("client", CLIENT_SESSION_ID);
		const socket = new wrapper_default(endpoint);
		let settled = false;
		const timer = setTimeout(() => {
			try {
				socket.terminate();
			} catch {}
			finish(/* @__PURE__ */ new Error("连接 Aa Browser 超时（3s）。"));
		}, 3e3);
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(socket);
		};
		socket.on("open", () => {
			ws = socket;
			log("connected to browser bridge", info.pid, info.port);
			socket.on("message", (raw) => {
				let msg;
				try {
					msg = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (msg?.event === "progress") {
					if (pending.get(msg.id)?.socket !== socket) return;
					const token = bridgeToProgressToken.get(msg.id);
					if (token !== void 0) {
						const params = {
							progressToken: token,
							progress: msg.progress
						};
						if (typeof msg.total === "number") params.total = msg.total;
						if (typeof msg.message === "string") params.message = msg.message;
						notify("notifications/progress", params);
					}
					return;
				}
				if (typeof msg?.id === "number" && pending.has(msg.id)) {
					const p = pending.get(msg.id);
					if (p.socket !== socket) return;
					clearTimeout(p.timer);
					pending.delete(msg.id);
					bridgeToProgressToken.delete(msg.id);
					log("received browser tool response", msg.id, !!msg.ok);
					if (msg.ok) p.resolve(msg.result);
					else p.reject(new Error(msg.error || "工具执行失败"));
				}
			});
			socket.on("close", () => {
				if (ws === socket) ws = null;
				for (const [id, p] of pending) {
					if (p.socket !== socket) continue;
					if (isRetryable(p.name, p.args)) {
						pending.delete(id);
						bridgeToProgressToken.delete(id);
						if (p.mcpId !== void 0) mcpToBridge.set(p.mcpId, -2);
						p.id = null;
						p.socket = null;
						suspended.add(p);
						log("browser disconnected; queued read-only call for replay:", p.name);
						continue;
					}
					rejectPending(p, /* @__PURE__ */ new Error("与 Aa Browser 的连接已断开。此操作不会自动重试；请重新读取页面状态后再继续。"));
				}
				scheduleSuspendedReconnect();
			});
			socket.on("error", (err) => log("ws error:", err.message));
			flushSuspended(socket);
			finish();
		});
		socket.on("error", (err) => finish(/* @__PURE__ */ new Error(`无法连接 Aa Browser: ${err.message}`)));
		socket.once("close", () => finish(/* @__PURE__ */ new Error("与 Aa Browser 的连接已断开。")));
	});
	connecting = attempt;
	attempt.finally(() => {
		if (connecting === attempt) connecting = null;
	}).catch(() => {});
	return attempt;
}
/** 更新安装期间只等新实例回来，绝不自动启动，避免与安装器抢文件。 */
async function waitForUpdateRestart() {
	const deadline = Date.now() + UPDATE_RESTART_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			return await connectWs();
		} catch {}
		if (!updateRestartPending()) return null;
		await delay(CONNECT_RETRY_MS);
	}
	return null;
}
async function getWs() {
	if (ws && ws.readyState === wrapper_default.OPEN) return ws;
	let lastError;
	if (updateRestartPending()) {
		const restarted = await waitForUpdateRestart();
		if (restarted) return restarted;
	}
	try {
		return await connectWs();
	} catch (error) {
		lastError = error;
	}
	await ensureBrowserStarted();
	const deadline = Date.now() + AUTO_LAUNCH_TIMEOUT_MS;
	while (Date.now() < deadline) try {
		return await connectWs();
	} catch (error) {
		lastError = error;
		await delay(CONNECT_RETRY_MS);
	}
	throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error("无法连接 Aa Browser。");
}
/**
* 启动即连接（带重试）：桥被 AI 客户端拉起时立刻连上浏览器，
* 让桌面端"Agent 已连接"指示灯在会话开始时就点亮；
* 浏览器未启动/正在重启时静默重试，浏览器重启（换端口）后也会自动重连。
*/
const EAGER_CONNECT_RETRY_MS = 5e3;
function startEagerConnect() {
	setInterval(() => {
		if (ws && ws.readyState === wrapper_default.OPEN) return;
		connectWs().catch(() => {});
	}, EAGER_CONNECT_RETRY_MS).unref?.();
}
startEagerConnect();
async function callTool(name, args, progressToken) {
	const mcpId = args?.__mcpId;
	let socket;
	try {
		socket = await getWs();
	} catch (error) {
		if (mcpId !== void 0) cancelledMcpRequests.delete(mcpId);
		throw error;
	}
	if (mcpId !== void 0 && cancelledMcpRequests.delete(mcpId)) throw new Error("MCP 请求已取消。");
	const cleanArgs = { ...args ?? {} };
	delete cleanArgs.__mcpId;
	return new Promise((resolve, reject) => {
		const p = {
			id: null,
			name,
			args: cleanArgs,
			progressToken,
			mcpId,
			socket: null,
			resolve,
			reject,
			timer: null
		};
		p.timer = setTimeout(() => {
			const owner = p.socket;
			const wireId = p.id;
			detachPending(p);
			try {
				if (owner && owner.readyState === wrapper_default.OPEN && wireId !== null) owner.send(JSON.stringify({
					id: wireId,
					cancel: true
				}));
			} catch {}
			reject(/* @__PURE__ */ new Error(`工具 ${name} 执行超时（${CALL_TIMEOUT_MS / 1e3}s）`));
		}, CALL_TIMEOUT_MS);
		sendPending(p, socket);
	});
}
function writeStdioMessage(message) {
	const json = JSON.stringify(message).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
	node_process.default.stdout.write(`${json}\n`);
}
function send(msg) {
	log("stdio response", msg.id, msg.error ? "error" : "result");
	writeStdioMessage(msg);
}
function notify(method, params) {
	writeStdioMessage({
		jsonrpc: "2.0",
		method,
		params
	});
}
function rpcResult(id, result) {
	send({
		jsonrpc: "2.0",
		id,
		result
	});
}
function rpcError(id, code, message) {
	send({
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message
		}
	});
}
function toolResultForMcp(result) {
	return {
		content: (result?.content ?? []).map((c) => {
			if (c.type === "image") return {
				type: "image",
				data: c.data,
				mimeType: c.mimeType || "image/png"
			};
			return {
				type: "text",
				text: String(c.text ?? "")
			};
		}),
		isError: !!result?.isError
	};
}
function handleStdioLine(line) {
	const s = line.trim();
	if (!s) return;
	let msg;
	try {
		msg = JSON.parse(s);
	} catch {
		return;
	}
	if (msg.jsonrpc !== "2.0") return;
	const { id, method, params } = msg;
	if (method === "notifications/cancelled") {
		const requestId = params?.requestId;
		const bridgeId = mcpToBridge.get(requestId);
		if (bridgeId !== void 0) {
			if (bridgeId === -1) cancelledMcpRequests.add(requestId);
			else if (bridgeId === -2) {
				for (const p of [...suspended]) if (p.mcpId === requestId) rejectPending(p, /* @__PURE__ */ new Error("MCP 请求已取消。"));
			} else {
				const p = pending.get(bridgeId);
				if (p) {
					detachPending(p);
					p.reject(/* @__PURE__ */ new Error("MCP 请求已取消。"));
					try {
						if (p.socket?.readyState === wrapper_default.OPEN) p.socket.send(JSON.stringify({
							id: bridgeId,
							cancel: true
						}));
					} catch {}
				}
			}
			mcpToBridge.delete(requestId);
		}
		return;
	}
	if (id === void 0 || id === null) {
		if (method === "notifications/initialized") return;
		if (method === "notifications/roots/list") return;
		return;
	}
	switch (method) {
		case "initialize":
			rpcResult(id, {
				protocolVersion: params?.protocolVersion || "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: {
					name: "aa-browser",
					title: "Aa Browser",
					version: VERSION
				}
			});
			break;
		case "ping":
			rpcResult(id, {});
			break;
		case "tools/list":
			rpcResult(id, { tools: TOOL_DEFS.map((t) => ({
				name: t.name,
				title: t.title,
				description: t.description,
				inputSchema: t.inputSchema,
				annotations: {
					title: t.title,
					...TOOL_ANNOTATIONS[t.name]
				}
			})) });
			break;
		case "tools/call": {
			const name = params?.name;
			const args = params?.arguments ?? {};
			const rawProgressToken = params?._meta?.progressToken;
			const progressToken = typeof rawProgressToken === "string" || typeof rawProgressToken === "number" ? rawProgressToken : void 0;
			if (!TOOL_DEFS.find((t) => t.name === name)) {
				rpcError(id, -32602, `未知工具: ${name}`);
				break;
			}
			mcpToBridge.set(id, -1);
			callTool(name, {
				...args,
				__mcpId: id
			}, progressToken).then((result) => {
				if (mcpToBridge.has(id)) {
					mcpToBridge.delete(id);
					rpcResult(id, toolResultForMcp(result));
				}
			}).catch((err) => {
				mcpToBridge.delete(id);
				rpcResult(id, {
					content: [{
						type: "text",
						text: String(err?.message ?? err)
					}],
					isError: true
				});
			});
			break;
		}
		case "resources/list":
			rpcResult(id, { resources: [] });
			break;
		case "prompts/list":
			rpcResult(id, { prompts: [] });
			break;
		case "completion/complete":
			rpcResult(id, { completion: { values: [] } });
			break;
		default: rpcError(id, -32601, `方法不支持: ${method}`);
	}
}
let stdioBuffer = "";
node_process.default.stdin.setEncoding("utf8");
node_process.default.stdin.on("data", (chunk) => {
	stdioBuffer += chunk;
	let start = 0;
	for (let end = stdioBuffer.indexOf("\n"); end !== -1; end = stdioBuffer.indexOf("\n", start)) {
		handleStdioLine(stdioBuffer.slice(start, end));
		start = end + 1;
	}
	stdioBuffer = stdioBuffer.slice(start);
});
node_process.default.stdin.on("end", () => {
	if (stdioBuffer) handleStdioLine(stdioBuffer);
	try {
		ws?.close();
	} catch {}
	node_process.default.exit(0);
});
node_process.default.on("SIGINT", () => {
	try {
		ws?.close();
	} catch {}
	node_process.default.exit(0);
});
log(`stdio MCP bridge started (waiting for client initialize)`);
