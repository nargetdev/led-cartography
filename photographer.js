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
var workerFarm = require('worker-farm');
var join = require('join').Join;
var aWrite = require('atomic-write');

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
   .option('denoise', {
      default: 600,
      help: 'Lightmap denoise level',
   })
   .option('blacklevel', {
      default: 25,
      help: 'Lightmap black level, should be high enough that background is zero',
   })
   .option('fcserver', {
      default: 'ws://localhost:7890',
      help: 'Fadecandy server URL',
   })
   .option('striplimit', {
      default: 8,
      help: 'Optionally limit the number of strips used per controller'
   })
   .parse();


/*
 * Two worker pools for CPU-hungry image manipulation routines,
 * one for high-priority and one for low-priority.
 */

var highPriorityWorkers = workerFarm({
    maxConcurrentWorkers: opts.concurrency,
    maxConcurrentCallsPerWorker: 1,
}, require.resolve('./lib/image-worker.js'), [
    'thumbnailer',
    'calculatePeakDiff',
    'calculateMoments',
]);
var lowPriorityWorkers = workerFarm({
    maxConcurrentWorkers: opts.concurrency,
    maxConcurrentCallsPerWorker: 1,
}, require.resolve('./lib/image-worker.js'), [
    'extractDarkPGM',
    'calculateLightImage',
]);


function generateThumbnail(name, io, jNode, callback)
{
    /*
     * Generate a downsampled thumbnail if we don't already have one
     */

    if (jNode.thumbFile && fs.existsSync(path.join(io.dataPath, jNode.thumbFile))) {
        return callback();
    }

    var rawFilePath = path.join(io.dataPath, jNode.rawFile);
    var thumbFile = 'thumb-' + name + '.png';
    var thumbPath = path.join(io.dataPath, thumbFile);

    highPriorityWorkers.thumbnailer(rawFilePath, thumbPath, opts.thumbscale, function (err) {
        if (err) return callback(err);

        // Success
        console.log("Processed thumbnail " + name);
        jNode.thumbFile = thumbFile;
        callback();
    });
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

            // Delete data that's generated based on the raw photo
            delete jNode.thumbFile;
            delete jNode.lightmap;

            // As soon as we've taken the picture, move on to the next step
            // and process the photo a little in the background.
            photoCallback();

            // Asynchronously write RAW image to disk
            var rawFile = 'raw-' + name + '.CR2';
            aWrite.writeFile(path.join(io.dataPath, rawFile), image, function(err) {
                if (err) return finalCallback(err);
                jNode.rawFile = rawFile;
                finalCallback();
            });
        });
    });
}


function photographLed(led, io, json, jLed, photoCallback, finalCallback)
{
    // Photograph a single LED only if the json doesn't already contain a valid RAW photo.
    // Takes dark frames as necessary. This is a no-op if the photo already exists.

    photographCommon(led.string, io, jLed, function (callback) {

        var darkFrame = currentDarkFrameIndex(json);

        photographDarkness(io, json, darkFrame, function (err) {
            if (err) return finalCallback(err);

            // Dark frame, taken in the recent past
            jLed.darkFrame = darkFrame;

            console.log('Photographing ' + led.string);
            io.fc.singleLight({serial: led.device}, led.index, callback);
        });

    }, photoCallback, finalCallback);
}


function darkFrameName(index)
{
    return 'dark-' + index;
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

    photographCommon(darkFrameName(index), io, jFrame, function (callback) {

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

    var darkIndex = jLed.darkFrame;
    var darkNode = json.darkFrames[darkIndex];
    var darkName = darkFrameName(darkIndex);

    generateThumbnail(darkName, io, darkNode, function (err) {
        if (err) return callback(err);

        highPriorityWorkers.calculatePeakDiff(
            path.join(io.dataPath, json.darkFrames[jLed.darkFrame].thumbFile),
            path.join(io.dataPath, jLed.thumbFile),
            function (err, result) {
                if (err) return callback(err);
                jLed.peakDiff = result;
                callback();
            }
        );
    });
}


function memoizeTask(taskMemo, name, callback)
{
    /*
     * If a task by the given name is already in taskMemo, add the callback
     * to the list and return null. If we're first, returns a function that
     * will invoke all callbacks that were added to the memo since.
     */

    if (name in taskMemo) {
        taskMemo[name].push(callback);
        return null;
    }

    taskMemo[name] = [callback];

    return function () {
        var cb = taskMemo[name];
        delete taskMemo[name];

        for (var i = 0; i < cb.length; i++) {
            cb[i].apply(arguments);
        }
    }
}


function generateDarkPGM(io, json, taskMemo, index, callback)
{
    /*
     * Generate the pgmFile for a dark frame, if it doesn't already exist.
     */

    var name = darkFrameName(index);

    // Combine this with other callbacks waiting on the same frame
    var complete = memoizeTask(taskMemo, name, callback);
    if (!complete) {
        return;
    }

    var jNode = json.darkFrames[index];
    if (jNode.pgmFile && fs.existsSync(path.join(io.dataPath, jNode.pgmFile))) {
        return complete();
    }

    var rawFilePath = path.join(io.dataPath, jNode.rawFile);
    var pgmFile = 'pgm-' + name + '.pgm';
    var pgmPath = path.join(io.dataPath, pgmFile);

    lowPriorityWorkers.extractDarkPGM(rawFilePath, pgmPath, function (err) {
        if (err) return callback(err);
        jNode.pgmFile = pgmFile;
        complete();
    });
}


function generateLightmap(name, io, json, jLed, taskMemo, callback)
{
    /*
     * Generate a linear 16-bit PNG file that represents just the light coming from
     * one LED, with the dark background subtracted.
     */

    if (jLed.peakDiff < opts.noisethreshold) {
        // This LED is below the noise threshold, assume it's missing
        delete jLed.lightmap;
        return callback();
    }

    if (jLed.lightmap && jLed.lightmap.file && fs.existsSync(path.join(io.dataPath, jLed.lightmap.file))) {
        return callback();
    }

    generateDarkPGM(io, json, taskMemo, jLed.darkFrame, function (err) {
        if (err) return callback(err);

        var lightFile = 'light-' + name + '.png';

        lowPriorityWorkers.calculateLightImage(
            path.join(io.dataPath, jLed.rawFile),
            path.join(io.dataPath, json.darkFrames[jLed.darkFrame].pgmFile),
            path.join(io.dataPath, lightFile),
            opts.denoise,
            opts.blacklevel,
            function(err) {
                if (err) return callback(err);

                // Success
                console.log("Processed lightmap " + name);
                jLed.lightmap = {file: lightFile};
                callback();
            }
        );
    });
}


function generateMoments(io, jLed, callback)
{
    /*
     * Calculate the moments for the lightmap image.
     * This lets us find the centroid and overall brightness of the light.
     * Also saves the lightmap size, since we're reading it in anyway.
     */

    if (jLed.lightmap == undefined || jLed.lightmap.moments != undefined) {
        // No lightmap (too dark), or moments already calculated
        return callback();
    }

    highPriorityWorkers.calculateMoments(
        path.join(io.dataPath, jLed.lightmap.file),
        function (err, obj) {
            if (err) return callback(err);
            jLed.lightmap.moments = obj.moments;
            jLed.lightmap.size = obj.size;
            jLed.lightmap.centroid = {
                x: obj.moments.m10 / obj.moments.m00,
                y: obj.moments.m01 / obj.moments.m00
            };
            callback();
        }
    );
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


function handleOneLed(led, io, json, taskMemo, photoCallback, finalCallback)
{
    /*
     * Handle the photography and processing for a single LED.
     * Skips any steps that have already been completed and recorded.
     */

    var jDev = (json.devices[led.device] = json.devices[led.device] || {strips: {}, leds: {}});
    var jStrip = (jDev.strips[led.stripIndex] = jDev.strips[led.stripIndex] || {});

    // Skip LEDs that are beyond the detected strip length
    if (jStrip.length != undefined && led.stripPosition >= jStrip.length) {
        photoCallback();
        finalCallback();
        return;
    }

    var jLed = (jDev.leds[led.index] = jDev.leds[led.index] || {});

    photographLed(led, io, json, jLed, photoCallback, function (err) {
        if (err) return finalCallback(err);
        async.waterfall([
            // Asynchronous processing for each photo

            async.apply(generateThumbnail, led.string, io, jLed),
            async.apply(generatePeakDiff, io, json, jLed),
            async.apply(updateStripLength, led.stripIndex, jDev),
            async.apply(generateLightmap, led.string, io, json, jLed, taskMemo),
            async.apply(generateMoments, io, jLed),

        ], finalCallback);
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

    leds = leds.filter(function(led) {
        return led.stripIndex < opts.striplimit;
    });

    return leds;
}


function photographer(dataPath, callback)
{
    if (!fs.statSync(dataPath).isDirectory()) {
        return callback("Data path must be a directory. Create a new empty directory to start from scratch.");
    }

    var pending = join.create();
    var taskMemo = {};

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
            aWrite.writeFile(jsonPath, savedJson, callback);
        }
    };

    process.on('SIGINT', function () {
        console.log("\nInterrupted; saving work.");
        jsonSaveFn(function () {
            // process.exit would often hang if we're stuck in gphoto
            process.kill(process.pid, 'SIGTERM');
        });
    });

    ioSetup(function (err, io) {
        if (err) return callback(err);
        io.dataPath = dataPath;

        async.mapSeries(collectLeds(io, json), function (led, callback) {

            /*
             * Immediately after photography, move to the next LED- but make
             * sure the processing callbacks finish eventually. Also checkpoint
             * the JSON after each LED finishes its background processing as
             * well as after each photo is taken.
             */

            function nextPhoto(err) {
                if (err) return callback(err);
                jsonSaveFn(callback);
            }

            async.waterfall([
                async.apply(handleOneLed, led, io, json, taskMemo, nextPhoto),
                jsonSaveFn,
            ], pending.add());

        }, function (err) {
            if (err) return callback(err);

            // Done with photography
            async.waterfall([
                async.apply(ioClose, io),
                jsonSaveFn,
            ], pending.add());

            console.log("Waiting for processing tasks to complete");
            pending.then(function () {
                workerFarm.end(lowPriorityWorkers);
                workerFarm.end(highPriorityWorkers);
                callback();
            });
        });
    });
}


photographer(opts.data, function (err) {
    if (err) {
        console.log(err);
        process.exit(1);
    }
    console.log("Done.");
});
