/*
 * fadecandy.js - Instead of speaking the device-agnostic Open Pixel Control protocol,
 *                this is a WebSocket client which uses the native fcserver API,
 *                capable of detecting and configuring specific attached devices.
 *
 * Not ready for general-purpose use yet; so far this is pretty minimal, and doesn't
 * handle devices connecting or disconnecting at runtime.
 *
 * Copyright (c) 2015 Micah Scott
 * Released under the MIT license.
 */

(function () {

	var WebSocket = require('ws');
	var async = require('async');

    var fadecandy = {};

    fadecandy.DEFAULT_TIMEOUT = 4000;
    fadecandy.LEDS_PER_DEVICE = 512;

    fadecandy.connect = function(url, callback) {
    	var connection = {};

    	connection.socket = new WebSocket(url);
    	connection.devices = [];
    	connection.pending = {};
    	connection.sequence = 1;

    	connection.message = function (obj, callback, timeout) {
    		timeout = timeout || fadecandy.DEFAULT_TIMEOUT;

    		obj.sequence = connection.sequence;
    		connection.sequence += 1;
    		var msgText = JSON.stringify(obj);

    		var timer = setTimeout( function timedOut() {
    			callback('Timed out waiting for fcserver to respond to this message: ' + msgText);
    			delete connection.pending[obj.sequence];
    		}, timeout);

    		connection.pending[obj.sequence] = function (obj) {
    			callback(null, obj);
    			delete connection.pending[obj.sequence];
    			clearTimeout(timer);
    		}

    		connection.socket.send(JSON.stringify(obj));
    	};

    	connection.socket.on('message', function message(data, err) {
    		var obj = JSON.parse(data);
    		connection.pending[obj.sequence](obj);
    	});

    	connection.socket.on('open', function open() {
    		connection.message( {type: 'list_connected_devices'} , function (err, obj) {
    			if (err) return callback(err);

    			// Sort device list by serial number, for a stable ordering
    			connection.devices = obj.devices;
    			connection.devices.sort(function (a, b) {
    				return a.serial.localeCompare(b.serial);
    			});

    			for (var i = 0; i < connection.devices.length; i++) {
    				console.log("Found Fadecandy device " + connection.devices[i].serial)
    			}

    			callback(null, connection);
    		});
    	});

    	connection.rawPixels = function (device, rgb, callback) {
    		// Disable interpolation, dithering, and gamma correction.
    		// Bypasses the mapping layer, and sends RGB values straight to a single FC device.

    		// Convert to raw array if necessary, so JSON serialize works
    		if (rgb.constructor != Array) {
    			rgb = Array.prototype.slice.call(rgb);
    		}

    		async.series([
    			async.apply(connection.message, {
	    			type: 'device_options',
	    			device: device,
	    			options: {
	    				led: null,
	    				dither: false,
	    				interpolate: false
	    			},
		    	}),
    			async.apply(connection.message, {
	    			type: 'device_color_correction',
	    			device: device,
	    			color: {
	    				gamma: 1.0,
	    				whitepoint: [1.0, 1.0, 1.0]
	    			},
		    	}),
    			async.apply(connection.message, {
	    			type: 'device_pixels',
	    			device: device,
	    			pixels: rgb,
		    	}),
		    ], callback);
		}

        connection.lightsOff = function (callback) {
            // Turn all lights off, on all devices

            async.map(connection.devices, function (thisDevice, callback) {
                var array = new Uint8Array(fadecandy.LEDS_PER_DEVICE * 3);
                connection.rawPixels(thisDevice, array, callback);
            }, callback);
        }

        connection.singleLight = function (device, index, callback) {
            // Turn a single light on at full brightness, and all others off

            async.map(connection.devices, function (thisDevice, callback) {
                var array = new Uint8Array(fadecandy.LEDS_PER_DEVICE * 3);
                if (device.serial == thisDevice.serial) {
                    for (var i = 0; i < 3; i++) {
                        array[3*index + i] = 255;
                    }
                }
                connection.rawPixels(thisDevice, array, callback);
            }, callback);
        }
    }

    module.exports = fadecandy;

}());