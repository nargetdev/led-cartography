#!/usr/bin/env node
/*
 * Convert an LED layout to an annotated SVG file that can be edited by
 * hand using tools like Adobe Illustrator, or merge edits back into
 * the layout file.
 *
 * Each LED is represented by a zero-length line with stroke, so that
 * transformations like Illustrator's Envelope Distort don't affect the
 * representation.
 *
 * Copyright (c) 2015 Micah Elizabeth Scott
 * Released under the MIT license, see the accompanying LICENSE file.
 */

var fs = require('fs');
var path = require('path');
var libxmljs = require('libxmljs');

var opts = require("nomnom")
   .option('layout', {
      abbr: 'l',
      required: true,
      help: 'Layout JSON file'
   })
   .option('svg', {
      abbr: 's',
      help: 'SVG file to create or merge'
   })
   .option('stroke', {
      default: 5,
      help: 'Stroke width for points'
   })
   .option('width', {
      default: 2604,
      help: 'Width of SVG, in pixels'
   })
   .option('height', {
      default: 1738,
      help: 'Height of SVG, in pixels'
   })
   .parse();


function coordLayoutToSVG(node)
{
    if (node && node.point) {
        return { x: node.point[0], y: node.point[1] }
    }
}


function coordSVGToLayout(xy, node)
{
    node.point[0] = xy.x;
    node.point[1] = xy.y;
}


function ledIdString(index)
{
    return 'led-' + index;
}


function svgFromLayout(layout)
{
    var svg = libxmljs.parseXml(
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' +
        '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve"></svg>');

    svg.root().attr({
        width: opts.width,
        height: opts.height,
    });

    for (var i = 0; i < layout.length; i++) {
        var xy = coordLayoutToSVG(layout[i]);
        if (xy) {
            svg.root().node('line').attr({
                id: ledIdString(i),
                fill: 'none',
                stroke: '#000000',
                'stroke-width': opts.stroke,
                'stroke-linecap': 'round',
                x1: xy.x,
                x2: xy.x,
                y1: xy.y,
                y2: xy.y,
            });
        }
    }

    return svg;
}


function updateLayout(layout, svg)
{
    for (var i = 0; i < layout.length; i++) {
        if (layout[i] && layout[i].point) {
            var node = svg.get("//xmlns:line[@id='" + ledIdString(i) + "']", 'http://www.w3.org/2000/svg');
            if (node) {
                coordSVGToLayout({
                    x: +node.attr('x1').value(),
                    y: +node.attr('y1').value(),
                }, layout[i]);
            } else {
                console.log("Missing element for LED " + i);
            }
        }
    }
}


(function () {
    var layout = JSON.parse(fs.readFileSync(opts.layout));

    if (fs.existsSync(opts.svg)) {
        updateLayout(layout, libxmljs.parseXml(fs.readFileSync(opts.svg)));
        fs.writeFileSync(opts.layout, JSON.stringify(layout, null, '\t') + '\n');
        console.log("Updated layout " + opts.layout);
    } else {
        fs.writeFileSync(opts.svg, svgFromLayout(layout).toString());
        console.log("Created " + opts.svg);
    }
})();
