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
      abbr: 'l',
      help: 'Path to JSON layout file we output [<data>/layout.json]'
   })
   .option('config', {
      abbr: 'c',
      help: 'Path to JSON config file we output [<data>/fcserver.json]'
   })
   .option('scale', {
      abbr: 's',
      default: 4,
      help: 'How many OPC units wide should our photos be?'
   })
   .option('plane', {
      abbr: 'p',
      default: 'xz',
      help: 'Which 2D plane should we map the photos to?'
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

        if (led.lightmap) {
            var opcIndex = cf.mapPixel(serial, index);
            var centroid = led.lightmap.centroid;
            var aspect = led.lightmap.size.width / led.lightmap.size.height;

            layout[opcIndex] = {
                point: mapToPlane(
                    (centroid.x - 0.5) * opts.scale,
                    (centroid.y - 0.5) * opts.scale / aspect
                )
            };
        }
    }
}

fs.writeFileSync(opts.config, JSON.stringify(cf.json, null, '\t') + '\n');
fs.writeFileSync(opts.layout, JSON.stringify(layout, null, '\t') + '\n');
