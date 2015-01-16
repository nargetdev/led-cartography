#!/usr/bin/env node
/*
 * Experimental tool for gathering high quality RAW photographs
 * of each LED in an installation, for later processing into layouts
 * and image-based models of various sorts.
 *
 * Copyright (c) 2015 Micah Elizabeth Scott
 * Released under the MIT license, see the accompanying LICENSE file.
 */

var fadecandy = require('./lib/fadecandy.js');
var GPhoto = require('gphoto2');
var async = require('async');
var sprintf = require('sprintf-js').sprintf;
var fs = require('fs');
var util = require('util');
var crypto = require('crypto');
var cv = require('opencv');
var exec = require('child_process').exec;


var LEDStrip = function (device, index)
{
	/*
     * One LED strip has LEDs that are likely to be physically nearby.
     * We pseudorandomly choose remaining LEDStrips to photograph.
     * Each time we photograph an LEDStrip, we light up the next LED in sequence.
     * If we see a single missing LED, we'll skip over it
     * If we see several missing LEDs, we assume the strip has ended.
     */

	var strip = this;
    this.device = device;
    this.index = index;
    this.stripLength = 0;
    this.nextLed = 0;
    this.thumbnails = [];
    this.complete = false;

    var THUMBNAIL_SCALE_LOG2 = 3;	// Log2 of the amount to downscale thumbnails by before storage
    var MAXIMUM_GAP = 4;

    this.step = function (stepNumber, fc, camera, callback) {
    	var thisLed = strip.nextLed;
    	var fcLedIndex = strip.index * 64 + thisLed;
    	strip.nextLed += 1;

    	console.log(sprintf("Step %s - Fc #%s strip %d, led %d",
    		stepNumber, this.device.serial, strip.index, thisLed));

    	var filenameSlug = sprintf('%05d-%s-%03d', stepNumber, this.device.serial, fcLedIndex);

		fc.singleLight(strip.device, fcLedIndex, function (err) {
			if (err) return callback(err);

			camera.takePicture({download: true}, function (err, image) {
				if (err) return callback(err);

				// As soon as we've taken the picture, move on to the next step
				// and process the photo a little in the background.

				callback();

				strip.processImage(image, filenameSlug, thisLed, function (err) {
					if (err) return callback(err);
				});
			});
		});
	}

	this.processImage = function (image, filenameSlug, thisLed, callback) {
    	var rawFile = 'data/raw/' + filenameSlug + '.CR2';
    	var thumbFile = 'data/thumb/' + filenameSlug + '.jpg';

		async.waterfall([

			async.apply(fs.writeFile, rawFile, image),

			// Extract the thumbnail image (much faster than full processing)
			async.apply(exec, 'dcraw -e -c ' + rawFile, {encoding: 'binary', maxBuffer: 100 * 1024 * 1024}),

			// Let OpenCV parse and decompress the image
			function (stdout, stderr, callback) {
				var jpeg = new Buffer(stdout, 'binary');
				cv.readImage(jpeg, callback);
			},

			// Store a tiny grayscale version
			function (img, callback) {
				img.convertGrayscale();
				for (var i = 0; i < THUMBNAIL_SCALE_LOG2; i++) {
					img.pyrDown();
				}
				strip.thumbnails[thisLed] = img;
				img.save(thumbFile);
				callback();
			}

		], callback);
	}


    	// if (true) { // Did we see this LED?
    	// 	this.stripLength = thisLed + 1;
	    // 	if (this.stripLength == 64) {
    	// 		this.complete = true;
    	// 	}
    	// }
}


function cameraSetup(callback)
{
	var gphoto = new GPhoto.GPhoto2();
	gphoto.list( function (cameras) {
		var cam = cameras[0];
		if (cam) {
			console.log("Connected to " + cam.model)
			console.log("Setting up camera...");

			// Capture images to internal RAM
			cam.setConfigValue("capturetarget", 0, function (err) {
				console.log("Camera configured successfully");
				callback(err, cam);
			});

		} else {
			callback("No camera found: Make sure it's connected and awake");
		}
	});
}


function main(callback)
{
	async.parallel({

		fc: async.apply(fadecandy.connect, 'ws://localhost:7890'),
		camera: cameraSetup,

	}, function (err, data) {

		if (err) return callback(err);
		var fc = data.fc;
		var camera = data.camera;

		// We know about all of the attached Fadecandy boards; now create LEDStrip instances

		var strips = [];
		for (var dev = 0; dev < fc.devices.length; dev++) {
			for (var idx = 0; idx < 8; idx++) {
				strips.push(new LEDStrip(fc.devices[dev], idx));
			}
		}

		// Keep another array with just the strips we know still need work
		var pendingStrips = strips.slice();
		var stepNumber = 0;
		var seed = '';

		var nextStep = function (err) {
			if (err) return callback(err);

			stepNumber += 1;
			var shasum = crypto.createHash('sha1');
			shasum.update(seed + stepNumber);
			var stepHash = shasum.digest();

			// Done?
			if (pendingStrips.length == 0) {
				return callback(null);
			}

			// Repeatably choose a random pending strip
			var stripArrayIndex = stepHash.readUInt32LE(2) % pendingStrips.length;
			var strip = pendingStrips[stripArrayIndex];

			strip.step(stepNumber, fc, camera, function (err) {
				if (err) return callback(err);
				if (strip.complete) {
					pendingStrips.splice(stripArrayIndex, 1);
				}
				nextStep();
			});
		}

		nextStep();
	});
}


main(function (err) {
	if (err) {
		console.log(err);
		process.exit(1);
	}
});
