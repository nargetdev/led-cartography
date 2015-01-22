#!/usr/bin/env node
/*
 * Data gathering tool:
 *
 *   - Detects the attached Fadecandy boards
 *   - Detects the length of attached LED strips
 *   - Takes high quality RAW photographs of each active LED
 *   - Generates tiny grayscale thumbnails
 *   - Writes results to "photos.json"
 *
 * If you need to restart data gathering, this tool will avoid
 * retaking any photos that it's already taken, but existing
 * photos will be reprocessed.
 *
 * Copyright (c) 2015 Micah Elizabeth Scott
 * Released under the MIT license, see the accompanying LICENSE file.
 */

var fadecandy = require('./lib/fadecandy.js');
var GPhoto = require('gphoto2');
var async = require('async');
var fs = require('fs');
var os = require('os');
var path = require('path');
var util = require('util');
var randy = require('randy');
var cv = require('opencv');
var exec = require('child_process').exec;

var opts = require("nomnom")
   .option('data', {
      abbr: 'd',
      required: true,
      help: 'Data directory for photos and JSON'
   })
   .option('processonly', {
      abbr: 'p',
      flag: true,
      help: "Don't connect to Fadecandy or the camera, just process existing photos"
   })
   .option('concurrency', {
      abbr: 'c',
      default: os.cpus().length,
      help: 'How many processing tasks to run in parallel',
   })
   .option('thumbscale', {
      default: 3,
      help: 'Log2 of amount to downscale thumbnails by',
   })
   .option('noisethreshold', {
      default: 10,
      help: 'Below this peakDiff, assume an LED is missing',
   })
   .option('maxgap', {
      default: 2,
      help: 'If more than this many LEDs are missing, assume the strip has ended',
   })
   .option('darkinterval', {
      default: 60,
      help: 'Dark frames must be at least this recent, in seconds',
   })
   .option('fcserver', {
      default: 'ws://localhost:7890',
      help: 'Fadecandy server URL',
   })
   .parse();


var tempCounter = 0;

function tempSuffix()
{
    tempCounter += 1;
    return '_tmp' + tempCounter;
}

function atomicWriteFile(filename, data, callback)
{
    var tempFile = filename + tempSuffix();
    fs.writeFile(tempFile, data, function (err) {
        if (err) return callback(err);
        fs.rename(tempFile, filename, callback);
    });
}


function generateThumbnail(name, io, jNode, callback)
{
    /*
     * Generate a downsampled thumbnail if we don't already have one
     */

    if (jNode.thumbFile && fs.existsSync(path.join(io.dataPath, jNode.thumbFile))) {
        return callback();
    }

    async.waterfall([

        // Extract the thumbnail image (much faster than full processing)
        async.apply(exec, 'dcraw -e -c ' + path.join(io.dataPath, jNode.rawFile),
            {encoding: 'binary', maxBuffer: 100 * 1024 * 1024}),

        // Let OpenCV parse and decompress the image
        function (stdout, stderr, callback) {
            var jpeg = new Buffer(stdout, 'binary');
            cv.readImage(jpeg, callback);
        },

        // Compute and save the thumbnail
        function (img, callback) {
            console.log("Processing thumbnail " + name);

            img.convertGrayscale();
            for (var i = 0; i < opts.thumbscale; i++) {
                img.pyrDown();
            }

            var thumbFile = 'thumb-' + name + '.png';
            var filename = path.join(io.dataPath, thumbFile);
            var tempFile = filename + tempSuffix();

            img.save(tempFile);
            fs.rename(tempFile, filename, function (err) {

                // Success
                jNode.thumbFile = thumbFile;
                callback();

            });
        },
    ], callback);
}


function photographCommon(name, io, jNode, prepFn, photoCallback, finalCallback)
{
    /*
     * Core photography method shared for LED photos and dark frames.
     * prepFn() is invoked only if the photo needs to be taken, prior to shooting.
     * photoCallback() is invoked as soon as the camera is free,
     * and finalCallback() when the photo and thumbnail are both available.
     */

    if (jNode.rawFile && fs.existsSync(path.join(io.dataPath, jNode.rawFile))) {
        photoCallback();
        finalCallback();
        return;
    }

    prepFn(function (err) {
        if (err) return photoCallback(err);

        io.camera.takePicture({download: true}, function (err, image) {
            if (err) return photoCallback(err);

            // Timestamp as soon as the photo was taken
            jNode.timestamp = new Date().toJSON();

            // As soon as we've taken the picture, move on to the next step
            // and process the photo a little in the background.
            photoCallback();

            // Asynchronously write RAW image to disk
            var rawFile = 'raw-' + name + '.CR2';
            atomicWriteFile(path.join(io.dataPath, rawFile), image, function(err) {
                if (err) return finalCallback(err);
                jNode.rawFile = rawFile;
                finalCallback();
            });
        });
    });
}


function photographLed(led, io, jLed, photoCallback, finalCallback)
{
    // Photograph a single LED only if the json doesn't already contain a valid RAW photo.
    // Takes dark frames as necessary. This is a no-op if the photo already exists.

    photographCommon(led.string, io, jLed, function (callback) {

        var darkFrame = jLed.darkFrame || currentDarkFrameIndex(json);

        photographDarkness(io, json, darkFrame, function (err) {
            if (err) return finalCallback(err);

            // Dark frame, taken in the recent past
            jLed.darkFrame = darkFrame;

            console.log('Photographing ' + led.string);
            io.fc.singleLight({serial: led.device}, led.index, callback);
        });

    }, photoCallback, finalCallback);
}


function photographDarkness(io, json, index, callback)
{
    /*
     * Take a dark frame, store it with the indicated numerical index.
     * Dark frames don't have the fancy pipelined callbacks that normal LED
     * frames do, so it's easier to ensure the dark frame thumbnail is ready
     * before it's referenced by any other frames.
     */

    var jFrame = (json.darkFrames[index] = json.darkFrames[index] || {});

    photographCommon('dark-' + index, io, jFrame, function (callback) {

        console.log('Photographing dark frame ' + index);
        io.fc.lightsOff(callback);

    }, function (err) {
        // Photo done only; wait for the full completion on dark frames
        if (err) return callback(err);
    },
    callback);
}


function currentDarkFrameIndex(json)
{
    /*
     * Return a dark frame index to use for the current time.
     * If the latest dark frame is still recent enough, returns its index.
     * Otherwise returns the next unused index.
     */

    var index = json.darkFrames.length - 1;
    var frame = json.darkFrames[index];

    if (frame && frame.timestamp) {
        var ts = new Date(frame.timestamp).getTime();
        if (Date.now() - ts < opts.darkinterval * 1000) {
            return index;
        }
    }

    return index + 1;
}


function generatePeakDiff(io, json, jLed, callback)
{
    /*
     * Calculate the peak difference between this LED's image and its dark
     * frame, using only the tiny thumbnails. Store the result in 'peakDiff'.
     * Calculation is skipped if it's already been done.
     */

    if (jLed.peakDiff != undefined) {
        // Already calculated
        return callback();
    }

    async.map([
        path.join(io.dataPath, json.darkFrames[jLed.darkFrame].thumbFile),
        path.join(io.dataPath, jLed.thumbFile),
    ],
    cv.readImage, function (err, img) {
        if (err) return callback(err);

        // Meh, the RGB channels seem to come back when saving/loading thumbnails
        img[0].convertGrayscale();
        img[1].convertGrayscale();

        var diff = new cv.Matrix(img[0].width(), img[0].height());
        diff.absDiff(img[0], img[1]);

        jLed.peakDiff = diff.minMaxLoc().maxVal;
        callback();
    });
}


function updateStripLength(stripIndex, jDev, callback)
{
    /*
     * If we don't know this strip's length already, look for
     * runs of LEDs with a peakDiff below our threshold.
     */

    var jStrip = jDev.strips[stripIndex];

    if (jStrip.length != undefined) {
        // Already calculated
        return callback();
    }

    var gap = null;
    for (var i = 0; i < fadecandy.LEDS_PER_STRIP; i++) {
        var ledIndex = i + stripIndex * fadecandy.LEDS_PER_STRIP;
        var jLed = jDev.leds[ledIndex];

        if (!jLed || jLed.peakDiff == undefined) {
            // Not enough information yet
            return callback();
        }

        if (jLed.peakDiff >= opts.noisethreshold) {
            // LED is visible
            gap = null;
            continue;
        }

        // LED appears to be missing, gap begins or continues
        if (gap == null) {
            gap = i;
        }

        if (i - gap >= opts.maxgap) {
            // Assume this strip has ended
            jStrip.length = gap;
            return callback();
        }
    }

    // Full length strip
    jStrip.length = fadecandy.LEDS_PER_STRIP;
    return callback();
}

function handleOneLed(led, io, json, jsonSaveFn, queue, callback)
{
    /*
     * Handle the photography and processing for a single LED.
     * Skips any steps that have already been completed and recorded.
     */

    var jDev = (json.devices[led.device] = json.devices[led.device] || {strips: {}, leds: {}});
    var jStrip = (jDev.strips[led.stripIndex] = jDev.strips[led.stripIndex] || {});

    // Skip LEDs that are beyond the detected strip length
    if (jStrip.length != undefined && led.stripPosition >= jStrip.length) {
        return callback();
    }

    var jLed = (jDev.leds[led.index] = jDev.leds[led.index] || {});

    photographLed(led, io, jLed, callback, function (err) {
        if (err) return callback(err);
        queue.push(async.apply(async.waterfall, [
            // Asynchronous processing for each photo

            async.apply(generateThumbnail, led.string, io, jLed),
            async.apply(generatePeakDiff, io, json, jLed),
            async.apply(updateStripLength, led.stripIndex, jDev),
            jsonSaveFn,

        ]));
    });
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


function ioSetup(callback)
{
    var map = {};

    if (!opts.processonly) {
        map.fc = async.apply(fadecandy.connect, opts.fcserver);
        map.camera = cameraSetup;
    }

    async.parallel(map, callback);
}


function ioClose(io, callback)
{
    if (io.fc) {
        io.fc.lightsOff(function (err) {
            if (err) return callback(err);
            io.fc.socket.close();
            callback();
        });
    } else {
        callback();
    }
}


function collectLeds(io, json)
{
    var rng = randy.instance();

    // Persistent random seed
    if (json.random) {
        rng.setState(json.random);
    }
    json.random = rng.getState();

    if (io.fc) {
        // Shuffle the list of possible LEDs, so we visit them in an order that's been
        // decorrelated from their physical position.

        var leds = fadecandy.ledsForDeviceList(io.fc.devices);
        rng.shuffleInplace(leds);

    } else {
        // If we're operating without an FC server, just parse through the
        // existing LEDs we see in the JSON file.

        var leds = [];
        for (devSerial in (json.devices || {})) {
            leds = leds.concat(fadecandy.ledsForDevice(devSerial));
        }
    }

    leds.sort(function (a,b) { return a.stripPosition - b.stripPosition; });
    return leds;
}


function photographer(dataPath, callback)
{
    if (!fs.statSync(dataPath).isDirectory()) {
        return callback("Data path must be a directory. Create a new empty directory to start from scratch.");
    }

    var jsonPath = path.join(dataPath, 'photos.json');
    var lastSavedJson = fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath) : '{}';
    var json = JSON.parse(lastSavedJson);
    json.devices = json.devices || {};
    json.darkFrames = json.darkFrames || [];

    var jsonSaveFn = function (callback) {
        // Only write the JSON if it's changed
        var savedJson = JSON.stringify(json, null, '\t');
        if (savedJson == lastSavedJson) {
            callback();
        } else {
            lastSavedJson = savedJson;
            atomicWriteFile(jsonPath, savedJson, callback);
        }
    };

    var queue = async.queue(function (fn, callback) { fn(callback) }, opts.concurrency);

    ioSetup(function (err, io) {
        if (err) return callback(err);
        io.dataPath = dataPath;

        async.mapSeries(collectLeds(io, json), function (led, callback) {
            handleOneLed(led, io, json, jsonSaveFn, queue, callback);
        }, function (err) {
            // Done with photography; may still be background processing happening
            if (err) return callback(err);
            ioClose(io, function (err) {
                if (err) return callback(err);
                jsonSaveFn(callback);
            });
        });
    });
}


photographer(opts.data, function (err) {
    if (err) {
        console.log(err);
        process.exit(1);
    }
});
