function throwIfMissing(target, property) {
    if (target[property] == null) {
        throw new Error(`Event ${property} is not defined`);
    }
    return target[property];
}


module.exports = function (events = {}) {
    return new Proxy(events, { get: throwIfMissing });
};
