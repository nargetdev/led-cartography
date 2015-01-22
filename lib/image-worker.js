/*
 * Image processing worker for photographer.js
 */

var cv = require('opencv');
var async = require('async');
var exec = require('child_process').exec;


module.exports = {

    thumbnailer: function (rawPath, outputPath, thumbscale, callback) {
        async.waterfall([

            // Extract the thumbnail image (much faster than full processing)
            async.apply(exec, 'dcraw -e -c ' + rawPath,
                {encoding: 'binary', maxBuffer: 100 * 1024 * 1024}),

            // Let OpenCV parse and decompress the image
            function (stdout, stderr, callback) {
                var jpeg = new Buffer(stdout, 'binary');
                cv.readImage(jpeg, callback);
            },

            // Compute and save the thumbnail
            function (img, callback) {

                img.convertGrayscale();
                for (var i = 0; i < thumbscale; i++) {
                    img.pyrDown();
                }

                img.save(outputPath);
                callback();
            },

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

};
