#!/usr/bin/env node
/*
 * Use photometric data gathered by 'photographer.js',
 * generate an fcserver config file and an LED layout.
 *
 * This can operate on a single photography run, or it can
 * combine data from multiple mapping sessions. Later mappings
 * will override earlier on a per-controller basis.
 *
 * Copyright (c) 2015 Micah Elizabeth Scott
 * Released under the MIT license, see the accompanying LICENSE file.
 */

var fadecandy = require('./lib/fadecandy.js');
var fs = require('fs');
var path = require('path');

var opts = require("nomnom")
   .option('inputs', {
      position: 0,
      required: true,
      list: true,
      help: 'One or more input files (photos.json)'
   })
   .option('layout', {
      default: 'layout.json',
      help: 'Path to JSON layout file we output'
   })
   .option('config', {
      default: 'fcserver.json',
      help: 'Path to JSON config file we output'
   })
   .option('center', {
      abbr: 'c',
      flag: true,
      help: 'Place the origin at the center of the image [default: top-left]'
   })
   .option('width', {
      abbr: 'w',
      help: 'Scale images to be this wide in layout units [default: unscaled pixels]'
   })
   .option('plane', {
      abbr: 'p',
      default: 'xy',
      help: 'Which 2D plane should we extract into the SVG?'
   })
   .parse();

var cf = new fadecandy.ConfigFactory();
var layout = [];

function mapToPlane(x, y) {
    var point = [0,0,0];
    var axes = { x: [1,0,0], y: [0,1,0], z: [0,0,1] };
    for (var i = 0; i < 3; i++) {
        point[i] = x * axes[opts.plane[0]][i] + y * axes[opts.plane[1]][i];
    }
    return point;
}

// Combine inputs into one master device list
var devices = {};
for (var i = 0; i < opts.inputs.length; i++) {
    var jPhotos = JSON.parse(fs.readFileSync(opts.inputs[i]));
    for (var serial in jPhotos.devices) {
        var jDev = jPhotos.devices[serial];
        jDev._filename = opts.inputs[i];
        devices[serial] = jDev;
    }
}

for (var serial in devices) {
    var jDev = devices[serial];
    console.log("Device " + serial + " from " + jDev._filename);

    for (var index in jDev.leds) {
        index = index|0;
        var led = jDev.leds[index];

        if (!led.lightmap) {
            // Skipped this pixel entirely because it didn't show up on the thumbnail
            continue;
        }

        if (!led.lightmap.moments) {
            throw "Missing moments analysis for " + serial + "-" + index;
        }

        var size = led.lightmap.size;
        var centroid = led.lightmap.centroid;
        var x = centroid.x;
        var y = centroid.y;

        if (x == null || y == null) {
            // Got as far as lightmap calculation when it turns out the image was all-zero.
            // This happens if there's enough light to make it past the "noisethreshold" but
            // not enough to make it above the "blacklevel" after processing.
            continue;
        }

        // Allocate this LED in the OPC index space
        var opcIndex = cf.mapPixel(serial, index);

        if (opts.center) {
            x -= size.width / 2;
            y -= size.height / 2;
        }

        if (opts.width != null) {
            var s = opts.width / size.width;
            x *= s;
            y *= s;
        }

        layout[opcIndex] = {
            point: mapToPlane(x, y)
        };
    }
}

fs.writeFileSync(opts.config, JSON.stringify(cf.json, null, '\t') + '\n');
fs.writeFileSync(opts.layout, JSON.stringify(layout, null, '\t') + '\n');
