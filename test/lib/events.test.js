const assert = require("assert");
const eventMap = require("../../lib/eventMap");


describe("eventMap", () => {

    it("should return object with events", () => {
        const EVENTS = eventMap({ NOTIFY: "notify", INCOMING: "incoming" });
        assert(EVENTS.NOTIFY === "notify");
        assert(EVENTS.INCOMING === "incoming");
    });

    it("should throw if event name is invalid", () => {
        const EVENTS = eventMap({ NOTIFY: "notify", INCOMING: "incoming" });
        assert.throws(() => EVENTS.notify);
        assert.throws(() => EVENTS.invalid);
        assert.throws(() => EVENTS[null]);
        assert.throws(() => EVENTS[undefined]);
    });

    it("should return dynamically added properties", () => {
        const EVENTS = eventMap({ NOTIFY: "notify" });
        EVENTS.INCOMING = "incoming";
        assert(EVENTS.NOTIFY === "notify");
        assert(EVENTS.INCOMING === "incoming");
    });
});
