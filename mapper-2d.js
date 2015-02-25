#!/usr/bin/env node
/*
 * Use photometric data gathered by 'photographer.js',
 * generate an fcserver config file and an LED layout.
 *
 * Copyright (c) 2015 Micah Elizabeth Scott
 * Released under the MIT license, see the accompanying LICENSE file.
 */

var fadecandy = require('./lib/fadecandy.js');
var fs = require('fs');
var path = require('path');

var opts = require("nomnom")
   .option('data', {
      abbr: 'd',
      required: true,
      help: 'Data directory for photos and JSON'
   })
   .option('layout', {
      help: 'Path to JSON layout file we output [<data>/layout.json]'
   })
   .option('config', {
      help: 'Path to JSON config file we output [<data>/fcserver.json]'
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

opts.config = opts.config || path.join(opts.data, 'fcserver.json');
opts.layout = opts.layout || path.join(opts.data, 'layout.json');
var photos = JSON.parse(fs.readFileSync(path.join(opts.data, 'photos.json')))

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

for (var serial in photos.devices) {
    var jDev = photos.devices[serial];

    for (var index in jDev.leds) {
        index = index|0;
        var led = jDev.leds[index];

        if (!led.lightmap) {
            // Skipped this pixel entirely because it didn't show up on the thumbnail
            continue;
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
