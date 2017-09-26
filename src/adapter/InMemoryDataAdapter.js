class InMemoryDataAdapter {

    constructor(cache = {}) {
        this.cache = cache;
    }

    getData(id, cb) {
        if (this.cache[id] == null) {
            this.cache[id] = {};
        }
        cb(null, this.cache[id]);
    }

    storeData(id, data, cb) {
        this.cache[id] = data;
        cb && cb(null);
    }
}

module.exports = InMemoryDataAdapter;
