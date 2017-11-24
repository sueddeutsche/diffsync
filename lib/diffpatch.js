const jsondiffpatch = require("jsondiffpatch");

function create(options) {
    // set up the jsondiffpatch options
    // see here for options: https://github.com/benjamine/jsondiffpatch#options
    options = Object.assign({
        objectHash: (obj) => obj.id || obj._id || JSON.stringify(obj)
    }, options);

    return jsondiffpatch.create(options);
}

module.exports = {
    create
};
