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
* OpenCV, for image processing
* Node.js and some NPM modules listed in `package.json`

On Mac OS, you can install libgphoto2 and OpenCV with Homebrew, but npm needs some help to find the libraries:

    brew install gphoto2 opencv
    CXXFLAGS=-I/usr/local/include LDFLAGS=-L/usr/local/lib npm install
