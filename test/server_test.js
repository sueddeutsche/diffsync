/* eslint max-len: 0 */
const assert = require("assert");
const sinon = require("sinon");
const isArray = require("lodash.isarray");
const isObject = require("lodash.isobject");
const jsondiffpatch = require("../src/diffpatch").create();

const EventEmitter = require("events").EventEmitter;
const COMMANDS = require("../index").COMMANDS;
const Server = require("../index").Server;
const Adapter = require("../index").InMemoryDataAdapter;


describe("DiffSync Server", () => {

    const testRoom = "testRoom";
    function testTransport() {
        return {
            id: `${Math.random()}`,
            on: Function.prototype,
            emit: Function.prototype,
            join: Function.prototype,
            to: () => new EventEmitter()
        };
    }

    function testData(data) {
        return {
            registeredSockets: [],
            clientVersions: {},
            serverCopy: data
        };
    }

    function testAdapter() {
        return new Adapter({
            testRoom: {
                testData: 1,
                testArray: [{
                    awesome: true
                }]
            }
        });
    }

    function testServer() {
        return new Server(testAdapter(), testTransport());
    }

    describe("constructor", () => {

        it("should throw if no adapter or transport is passed", () => {
            assert.throws(() => new Server());
            assert.throws(() => new Server(testAdapter()));
            assert.doesNotThrow(() => new Server(testAdapter(), testTransport()));
        });

        it("should apply the correct options to jsondiffpatch", () => {
            const client = new Server(testAdapter(), testTransport(), {
                textDiff: {
                    minLength: 2
                }
            });

            assert(client.jsondiffpatch.options().textDiff.minLength === 2);
        });
    });

    describe("trackConnection", () => {

        let connection;

        beforeEach(() => {
            connection = new EventEmitter();
        });

        it("should bind the callbacks properly", () => {
            const server = testServer();
            const joinSpy = sinon.stub(server, "joinConnection", Function.prototype);
            const syncSpy = sinon.stub(server, "receiveEdit", Function.prototype);
            const testEdit = {};
            const testCb = Function.prototype;

            server.trackConnection(connection);

            connection.emit(COMMANDS.join, testRoom, testCb);

            assert(joinSpy.called);
            assert(joinSpy.calledWithExactly(connection, testRoom, testCb));
            assert(joinSpy.calledOn(server));

            connection.emit(COMMANDS.syncWithServer, testEdit, testCb);

            assert(syncSpy.called);
            assert(syncSpy.calledWithExactly(connection, testEdit, testCb));
            assert(syncSpy.calledOn(server));
        });
    });

    describe("getData", () => {

        let server;

        beforeEach(() => {
            server = testServer();
        });

        it("should return the correct data from the cache", () => {
            const data = { test: true };
            const spy = sinon.spy();
            const adapterSpy = sinon.spy(server.adapter, "getData");

            server.data[testRoom] = data;

            server.getData(testRoom, spy);

            assert(spy.called);
            assert(spy.calledWithExactly(null, data));
            assert(!adapterSpy.called, "it should not call the adapter");
        });

        it("should go to adapter if cache is empty", () => {
            const data = { test: true };
            const spy = sinon.spy();
            const adapterSpy = sinon.spy(server.adapter, "getData");

            server.adapter.cache[testRoom] = data;
            server.getData(testRoom, spy);

            assert(spy.called, "called the callback");
            assert(spy.args[0][1].serverCopy === data);

            assert(adapterSpy.called, "alled the adapter");
            assert(adapterSpy.calledWith(testRoom));
        });

        it("should not ask the adapter for the same data twice", () => {
            const spy = sinon.spy();
            const adapterSpy = sinon.stub(server.adapter, "getData", Function.prototype);

            server.getData(testRoom, spy);
            server.getData(testRoom, spy);

            assert(adapterSpy.calledOnce);
        });

        it("should create the correct format for data internally", () => {
            const data = { test: true };
            const spy = sinon.spy();

            server.adapter.cache[testRoom] = data;
            server.getData(testRoom, spy);

            assert(spy.called, "called the callback");
            assert(isArray(server.data[testRoom].registeredSockets), "correct data in `serverCopy`");
            assert(isObject(server.data[testRoom].clientVersions), "correct data in `clientVersions`");
            assert(isObject(server.data[testRoom].serverCopy), "correct data in `serverCopy`");
            assert(server.data[testRoom].serverCopy === data, "correct value of data in `serverCopy`");
        });
    });

    describe("joinConnection", () => {

        let server;
        let connection;

        beforeEach(() => {
            server = testServer();
            connection = testTransport();
        });

        it("calls the internal `getData` to fetch the data for a room", () => {
            const getDataSpy = sinon.stub(server, "getData");

            server.joinConnection({}, testRoom, Function.prototype);

            assert(getDataSpy.called);
        });

        it("returns the correct data to the client", (done) => {
            const data = testData({
                awesome: true
            });

            sinon.stub(server, "getData", (room, cb) => cb(null, data));

            server.joinConnection(connection, testRoom, (_data) => {
                assert.deepEqual(data.serverCopy, _data);
                done();
            });
        });

        it("connects the client to the right room", (done) => {
            const joinSpy = sinon.spy(connection, "join");

            server.joinConnection(connection, testRoom, () => {
                assert(joinSpy.called);
                assert(joinSpy.calledWithExactly(testRoom));
                done();
            });
        });

        it("adds the client to the internal tracking document and properly copies objects", (done) => {
            let trackingDoc;
            let clientVersion;

            server.joinConnection(connection, testRoom, (_data) => {
                trackingDoc = server.data[testRoom];
                clientVersion = trackingDoc.clientVersions[connection.id];
                assert.deepEqual(trackingDoc.serverCopy, _data, "the data that is being transferred to the client is equal to the server version");
                assert.deepEqual(clientVersion.shadow.doc, _data, "shadow doc is equal to transferred doc");
                assert.deepEqual(clientVersion.backup.doc, _data, "backup doc is equal to transferred doc");
                assert.notStrictEqual(clientVersion.backup.doc, _data, "backup doc and transferred doc are not the same reference");
                assert.notStrictEqual(clientVersion.shadow.doc, _data, "shadow doc and transferred doc are not the same reference");
                assert.notStrictEqual(clientVersion.backup.doc, clientVersion.shadow.doc, "backup doc and shadow doc are not the same reference");
                done();
            });
        });
    });

    describe("receiveEdit", () => {

        let server;
        let connection;
        let editMessage;

        beforeEach(() => {
            server = testServer();
            connection = testTransport();
            editMessage = {
                room: testRoom,
                serverVersion: 0,
                clientVersion: 0,
                edits: [{
                    serverVersion: 0,
                    localVersion: 0,
                    diff: JSON.parse(JSON.stringify(jsondiffpatch.diff(server.adapter.cache[testRoom], {
                        testArray: [{
                            awesome: false
                        }, {
                            newone: true
                        }]
                    })))
                }]
            };
        });

        function join() {
            server.joinConnection(connection, testRoom, Function.prototype);
        }

        it("gets data from the correct room", () => {
            const getDataSpy = sinon.stub(server, "getData", Function.prototype);

            server.receiveEdit(connection, editMessage, Function.prototype);

            assert(getDataSpy.called);
            assert(getDataSpy.calledWith(testRoom));
        });

        it("emits an error if it does not find a document for this client", () => {
            const emitSpy = sinon.spy(connection, "emit");

            server.receiveEdit(connection, editMessage, Function.prototype);

            assert(emitSpy.called);
            assert(emitSpy.calledWith(COMMANDS.error));
        });

        it("should perform a half server-side sync cycle", () => {
            const saveSnapshotSpy = sinon.spy(server, "saveSnapshot");
            const sendServerChangesSpy = sinon.stub(server, "sendServerChanges", Function.prototype);
            const emitter = new EventEmitter();
            const emitterSpy = sinon.spy(emitter, "emit");
            const toRoomSpy = sinon.stub(server.transport, "to", () => emitter);
            const initialLocalVersion = 0;

            join();
            server.receiveEdit(connection, editMessage, Function.prototype);

            const serverDoc = server.data[testRoom];
            const clientDoc = serverDoc.clientVersions[connection.id];

            // the shadow and the backup have to be different after that change
            assert.notDeepEqual(clientDoc.shadow.doc, clientDoc.backup.doc);
            assert.notDeepEqual(clientDoc.shadow.doc.testArray[0], clientDoc.backup.doc.testArray[0]);

            // the server testArray[0] and the shadow version should be the same by value and not by reference
            assert.deepEqual(clientDoc.shadow.doc.testArray[0], serverDoc.serverCopy.testArray[0]);
            assert.notStrictEqual(clientDoc.shadow.doc.testArray[0], serverDoc.serverCopy.testArray[0]);

            // the local version should be incremented by the diff
            assert(clientDoc.shadow.localVersion === initialLocalVersion + 1);

            assert(saveSnapshotSpy.called);
            assert(sendServerChangesSpy.called);

            assert(toRoomSpy.called);
            assert(toRoomSpy.calledWithExactly(testRoom));
            assert(emitterSpy.called);
            assert(emitterSpy.calledWithExactly(COMMANDS.remoteUpdateIncoming, connection.id));
        });

        it("should not send sync notifications if empty update", () => {
            const emitter = new EventEmitter();
            const emitterSpy = sinon.spy(emitter, "emit");

            // empty message
            editMessage.edits = [];

            join();
            server.receiveEdit(connection, editMessage, Function.prototype);

            assert(!emitterSpy.called);
        });

    });

    describe("saveSnapshot", () => {

        it("calls the storeData method of the adatpter", () => {
            const server = testServer();
            const storeDataSpy = sinon.spy(server.adapter, "storeData");

            server.saveSnapshot(testRoom);

            assert(storeDataSpy.called);
            assert(storeDataSpy.calledWith(testRoom, server.adapter.cache[testRoom]));
        });

        it("should save snaphots in correct order and wait for previous requests to finish", () => {
            const server = testServer();
            const storeDataSpy = sinon.stub(server.adapter, "storeData", Function.prototype);

            server.saveSnapshot(testRoom);
            server.saveSnapshot(testRoom);
            server.saveSnapshot(testRoom);
            server.saveSnapshot(testRoom);

            assert(storeDataSpy.calledOnce);
        });
    });

    describe("sendServerChanges", () => {

        const send = Function.prototype;
        let clientDoc;
        let doc;
        let server;

        beforeEach(() => {
            server = testServer();

            clientDoc = {
                edits: [],
                shadow: {
                    serverVersion: 0,
                    localVersion: 0,
                    doc: {
                        awesome: false
                    }
                }
            };

            doc = {
                serverCopy: {
                    awesome: true,
                    testArray: [{}]
                }
            };
        });

        it("should update the shadow serverVersion if diff not empty", () => {
            server.sendServerChanges(doc, clientDoc, send);
            assert(clientDoc.shadow.serverVersion === 1, "server version increased");

            clientDoc.shadow.doc = {};
            doc.serverCopy = {};
            server.sendServerChanges(doc, clientDoc, send);
            assert(clientDoc.shadow.serverVersion === 1, "server version is the same");
        });

        it("should send a diff and update the server´s shadow correctly", () => {
            const sendSpy = sinon.spy();

            server.sendServerChanges(doc, clientDoc, sendSpy);

            assert(sendSpy.called);
            assert.deepEqual(doc.serverCopy, clientDoc.shadow.doc);
            assert.notStrictEqual(doc.serverCopy, clientDoc.shadow.doc);
            assert.notStrictEqual(doc.serverCopy.testArray, clientDoc.shadow.doc.testArray);
            assert.notStrictEqual(doc.serverCopy.testArray[0], clientDoc.shadow.doc.testArray[0]);
        });
    });
});
