#!/usr/bin/env node

var fadecandy = require('./lib/fadecandy.js');
var GPhoto = require('gphoto2');
var async = require('async');


function main(callback) {
	async.parallel({

		fc: function (callback) {
			fadecandy.connect('ws://localhost:7890', callback);
		},

		camera: function (callback) {
			var gphoto = new GPhoto.GPhoto2();
			gphoto.list( function (cameras) {
				var cam = cameras[0];
				if (cam) {
					console.log("Connected to " + cam.model)
					callback(null, cam);
				} else {
					callback("No camera found: Make sure it's connected and awake");
				}
			});
		}

	}, function (err, data) {

		if (err) return callback(err);
		var fc = data.fc;
		var camera = data.camera;

		async.series([

			// Save JPEG images to RAM
			// function (cb) { camera.setConfigValue("capturetarget", 0, cb) },
			// function (cb) { camera.setConfigValue("imageformat", 0, cb) },

			// // Try not to be disturbed
			// function (cb) { camera.setConfigValue("autopoweroff", 600, cb) },
			// function (cb) { camera.setConfigValue("uilock", 1, cb) },

			// // Default shot settings
			// function (cb) { camera.setConfigValue("uilock", 1, cb) },
			// function (cb) { camera.setConfigValue("iso", 2, cb) },
			// function (cb) { camera.setConfigValue("whitebalance", 1, cb) },
			// function (cb) { camera.setConfigValue("drivemode", 0, cb) },         // Single photo
			// function (cb) { camera.setConfigValue("autoexposuremode", 3, cb) },  // Manual exposure
			// function (cb) { camera.setConfigValue("shutterspeed", 3, cb) },      // 1/15 shutter

			// Take a reference photo with the LEDs off
			function (callback) {
				camera.takePicture({download: true}, function (err, file) {
					if (err) return callback(err);

					console.log(file);
				});
			},

		], callback);
	});
}


main(function (err) {
	if (err) {
		console.log(err);
		process.exit(1);
	} else {
		console.log("Done.");
		process.exit(0);
	}
});


/*

	var pixels = new Uint8ClampedArray(512 * 3);

	pixels[4] = 255;

	fc.rawPixels(fc.devices[0], pixels, function (err) {
		if (err) throw err;
	});

		});



	}

	cam.takePicture({
		download: true,
	}, function (err, data) {
		console.log(data);
	});

});
# gphoto.list (cameras)->
#   if cameras.length and camera = cameras[0]
#     async.forEachSeries [0 .. 2], (i, cb)->
#       console.log "Taking photo " + i
#       camera.takePicture preview:true, (er, data)->
#         return cb er if er
#         console.log "Completed photo " + [i, er, data]
#         fs.writeFile "series_#{i}.jpg", data, "binary", (er)->
#           cb er
#     , (er)->
#       console.error er if er
#       console.log "done."
#   else
#     console.log "No camera found."

*/