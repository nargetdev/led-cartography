/*
 * Image processing worker for photographer.js
 */

var cv = require('opencv');
var async = require('async');
var childProcess = require('child_process');
var which = require('which');
var aWrite = require('atomic-write');

// Command line tools
var dcraw = which.sync('dcraw');

module.exports = {

    thumbnailer: function (rawPath, outputPath, thumbscale, callback) {
        async.waterfall([

            // Extract the thumbnail image (much faster than full processing)
            async.apply(childProcess.execFile, dcraw, [
                '-e', '-c',
                rawPath
            ], {
                encoding: 'binary',
                maxBuffer: 100 * 1024 * 1024
            }),

            // Let OpenCV parse and decompress the image
            function (stdout, stderr, callback) {
                var jpeg = new Buffer(stdout, 'binary');
                cv.readImage(jpeg, callback);
            },

            // Compute thumbnail
            function (img, callback) {
                img.convertGrayscale();
                for (var i = 0; i < thumbscale; i++) {
                    img.pyrDown();
                }
                callback(null, img);
            },

            // Compress 
            function (img, callback) {
                img.toBufferAsync(callback, {ext: '.png'});
            },

            // Save to disk
            function (buffer, callback) {
                aWrite.writeFile(outputPath, buffer, callback);
            }

        ], callback);
    },

    calculatePeakDiff: function (img1, img2, callback) {
        async.map([img1, img2], cv.readImage, function (err, img) {
            if (err) return callback(err);

            // Meh, the RGB channels seem to come back when saving/loading thumbnails
            img[0].convertGrayscale();
            img[1].convertGrayscale();

            var diff = new cv.Matrix(img[0].width(), img[0].height());
            diff.absDiff(img[0], img[1]);
            callback(null, diff.minMaxLoc().maxVal);
        });
    },

    extractDarkPGM: function (rawPath, outputPath, callback) {
        async.waterfall([

            // Extract the dark frame in PGM format, in the format needed by "dcraw -K"
            async.apply(childProcess.execFile, dcraw, [
                '-D', '-4', '-j', '-t', '0', '-c',
                rawPath
            ], {
                encoding: 'binary',
                maxBuffer: 100 * 1024 * 1024
            }),

            // Save to a specific path
            function (stdout, stderr, callback) {
                var data = new Buffer(stdout, 'binary');
                aWrite.writeFile(outputPath, data, callback);
            }

        ], callback);
    },
};
