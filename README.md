# LED Cartography

Experimental LED mapping tools to use alongside Fadecandy.

* Infer layout from physical structure using a camera
* Convert layout to an editable SVG
* Merge edited SVG back into layout

## Dependencies

* [Fadecandy](https://github.com/scanlime/fadecandy) fcserver running
* A DSLR camera that's compatible with gphoto2. I'm using a Canon EOS Rebel T5i
* On Mac OS, you'll want [this mac-gphoto-enabler tool](https://github.com/mejedi/mac-gphoto-enabler) to reversibly disable Mac OS's built-in PTP driver.
* gphoto2, for talking to your camera
* dcraw, for decoding RAW images and extracting thumbnails
* OpenCV, for analyzing images
* Node.js and some NPM modules listed in `package.json`

On Mac OS, you can install libgphoto2 and dcraw with Homebrew, but npm needs some help to find the libraries:

    brew install gphoto2 dcraw opencv
    CXXFLAGS=-I/usr/local/include LDFLAGS=-L/usr/local/lib npm install

## Steps

* Make the environment as dark as possible aside from the LEDs
* Set up the camera
    * Manual white balance, daylight
    * Manual focus
    * Manual exposure, 1/20 or slower
    * Manual ISO 100
    * RAW image format
    * The *brightest* part of the scene with the brightest visible LED should not be overexposed. We want an accurate measure of where the light for each LED goes, so the hotspots need to cool down a bit in our images. These images will generally look quite underexposed. That's fine.
    * `fadecandy/examples/python/chase.py` is useful for testing this
* Run `photographer.js`. It detects all attached Fadecandy boards, and takes a photo for each LED
    * It uses the camera's thumbnail to detect when the image stops changing, i.e. a particular LED string is done
    * Each LED is photographed in pseudorandom order, to decorrelate any environmental noise from LED position

* TBD offline tools to analyze those images

## Ideas for later

* RAW images
* Automatically find a good exposure / LED brightness
* Exposure bracketing / HDR
* Support for multiple cameras and 3D reconstruction
* Use detailed per-LED photos for interesting image-based rendering
* Ways to capture the same data using fewer photos.
    * Proof of concept binary mapper in the FC examples
    * Use liveview mode to quickly segment image into nonoverlapping groups of LEDs