class InMemoryDataAdapter {

    constructor(cache = {}) {
        this.cache = cache;
    }

    getData(id) {
        if (this.cache[id] == null) {
            this.cache[id] = {};
        }
        return Promise.resolve(this.cache[id]);
    }

    storeData(id, data) {
        this.cache[id] = data;
        return Promise.resolve();
    }
}

module.exports = InMemoryDataAdapter;
