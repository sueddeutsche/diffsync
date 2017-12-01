/* eslint max-len: 0 */
const assert = require("assert");
const sinon = require("sinon");
const isArray = require("lodash.isarray");
const isObject = require("lodash.isobject");
const jsondiffpatch = require("../../lib/diffpatch").create();

const EventEmitter = require("events").EventEmitter;
const COMMANDS = require("../../index").COMMANDS;
const SyncServer = require("../../server/SyncServer");
const SyncService = require("../../server/SyncService");
const Adapter = require("../../index").InMemoryDataAdapter;


describe("server SyncService", () => {

    const testRoom = "testRoom";
    function testTransport() {
        const transport = new EventEmitter();
        transport.id = `${Math.random()}`;
        transport.join = Function.prototype;
        transport.to = () => new EventEmitter();
        return transport;
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
        return new SyncService(testAdapter());
    }

    describe("constructor", () => {

        it("should throw if no adapter is passed", () => {
            assert.throws(() => new SyncService());
            assert.doesNotThrow(() => new SyncService(testAdapter()));
        });

        it("should apply the correct options to jsondiffpatch", () => {
            const client = new SyncService(testAdapter(), {
                textDiff: {
                    minLength: 2
                }
            });

            assert(client.jsondiffpatch.options.textDiff.minLength === 2);
        });
    });

    describe("SyncServer", () => {

        let connection;

        beforeEach(() => {
            connection = new EventEmitter();
        });

        it("should bind the callbacks properly", () => {
            const server = new SyncServer(testTransport(), testAdapter());
            const service = server.syncService;
            const joinSpy = sinon.stub(service, "joinConnection").callsFake(Function.prototype);
            const syncSpy = sinon.stub(service, "receiveEdit").callsFake(Function.prototype);
            const testEdit = {};
            const testCb = Function.prototype;
            server.transport.emit("connection", connection);

            connection.emit(COMMANDS.join, "credentials", testRoom, testCb);

            assert(joinSpy.called);
            assert(joinSpy.calledWithExactly(connection, testRoom, testCb));
            assert(joinSpy.calledOn(service));

            connection.emit(COMMANDS.syncWithServer, testEdit, testCb);

            assert(syncSpy.called);
            assert(syncSpy.calledWithExactly(connection, testEdit, testCb));
            assert(syncSpy.calledOn(service));
        });
    });

    describe("getData", () => {

        let server;

        beforeEach(() => {
            server = testServer();
        });

        it("should return the correct data from the cache", () => {
            const data = { test: true };
            const adapterSpy = sinon.spy(server.adapter, "getData");
            server.data[testRoom] = data;

            return server.getData(testRoom)
                .then((response) => {
                    assert.deepEqual(data, response);
                    assert(!adapterSpy.called, "it should not call the adapter");
                });
        });

        it("should go to adapter if cache is empty", () => {
            const data = { test: true };
            const adapterSpy = sinon.spy(server.adapter, "getData");

            server.adapter.cache[testRoom] = data;

            return server.getData(testRoom)
                .then((response) => {
                    assert.deepEqual(response.serverCopy, data);
                    assert(adapterSpy.called, "called the adapter");
                    assert(adapterSpy.calledWith(testRoom));
                });
        });

        it("should not ask the adapter for the same data twice", () => {
            const adapterSpy = sinon.stub(server.adapter, "getData").callsFake(() => Promise.resolve());

            return Promise.all(
                [
                    server.getData(testRoom),
                    server.getData(testRoom)
                ])
                .then(() => assert(adapterSpy.calledOnce));
        });

        it("should create the correct format for data internally", () => {
            const data = { test: true };

            server.adapter.cache[testRoom] = data;

            return server.getData(testRoom)
                .then(() => {
                    assert(isArray(server.data[testRoom].registeredSockets), "correct data in `serverCopy`");
                    assert(isObject(server.data[testRoom].clientVersions), "correct data in `clientVersions`");
                    assert(isObject(server.data[testRoom].serverCopy), "correct data in `serverCopy`");
                    assert(server.data[testRoom].serverCopy === data, "correct value of data in `serverCopy`");
                });
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
            const getDataSpy = sinon.spy(server, "getData");

            return server.joinConnection(testTransport(), testRoom, () => {
                assert(getDataSpy.called);
            });
        });

        it("returns the correct data to the client", (done) => {
            const data = testData({ awesome: true });

            sinon.stub(server, "getData").callsFake(() => Promise.resolve(data));

            return server.joinConnection(connection, testRoom, (_data) => {
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
        let service;
        let connection;
        let editMessage;

        beforeEach(() => {
            server = new SyncServer(testTransport(), testAdapter());
            service = server.syncService;
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
            return new Promise((resolve) => service.joinConnection(connection, testRoom, resolve));
        }

        it("gets data from the correct room", () => {
            const getDataSpy = sinon.stub(service, "getData").callsFake(() => Promise.resolve({ clientVersions: {} }));

            return service
                .receiveEdit(connection, editMessage, Function.prototype)
                .then(() => {
                    assert(getDataSpy.called);
                    assert(getDataSpy.calledWith(testRoom));
                });
        });

        it("emits an error if it does not find a document for this client", () => {
            const emitSpy = sinon.spy(connection, "emit");

            service.receiveEdit(connection, editMessage, Function.prototype)
                .then(() => {
                    assert(emitSpy.called);
                    assert(emitSpy.calledWith(COMMANDS.error));
                });
        });

        it("should perform a half server-side sync cycle", () => {
            const saveSnapshotSpy = sinon.spy(service, "saveSnapshot");
            const sendServerChangesSpy = sinon.stub(service, "sendServerChanges").callsFake(Function.prototype);
            const emitter = new EventEmitter();
            const emitterSpy = sinon.spy(emitter, "emit");
            const toRoomSpy = sinon.stub(server.transport, "to").callsFake(() => emitter);
            const initialLocalVersion = 0;

            return join()
                .then(() => service.receiveEdit(connection, editMessage, Function.prototype))
                .then(() => {
                    const serverDoc = service.data[testRoom];
                    const clientDoc = serverDoc.clientVersions[connection.id];

                    // the shadow and the backup have to be different after that change
                    assert.notDeepEqual(clientDoc.shadow.doc, clientDoc.backup.doc);
                    assert.notDeepEqual(clientDoc.shadow.doc.testArray[0], clientDoc.backup.doc.testArray[0]);

                    // the service testArray[0] and the shadow version should be the same by value and not by reference
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
        });

        it("should not send sync notifications if empty update", () => {
            const emitter = new EventEmitter();
            const emitterSpy = sinon.spy(emitter, "emit");
            // empty message
            editMessage.edits = [];

            return join()
                .then(() => service.receiveEdit(connection, editMessage, Function.prototype))
                .then(() => {
                    assert(!emitterSpy.called);
                });
        });

    });

    describe("saveSnapshot", () => {

        it("calls the storeData method of the adatpter", () => {
            const server = testServer();
            const storeDataSpy = sinon.spy(server.adapter, "storeData");

            return server
                .saveSnapshot(testRoom)
                .then(() => {
                    assert(storeDataSpy.called);
                    assert(storeDataSpy.calledWith(testRoom, server.adapter.cache[testRoom]));
                });
        });

        it("should save snaphots in correct order and wait for previous requests to finish", () => {
            const server = testServer();
            const storeDataSpy = sinon.stub(server.adapter, "storeData").callsFake(() => Promise.resolve());

            // the first call starts saving, the next calls are queued, which trigger a final save
            return Promise.all(
                [
                    server.saveSnapshot(testRoom),
                    server.saveSnapshot(testRoom),
                    server.saveSnapshot(testRoom),
                    server.saveSnapshot(testRoom)
                ])
            .then(() => assert(storeDataSpy.calledTwice, `Should have called saveSnapshot twice, but called: ${storeDataSpy.callCount}`));
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
