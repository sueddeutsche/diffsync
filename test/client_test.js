/* eslint max-len: 0 */
const assert = require("assert");
const sinon = require("sinon");
const isEmpty = require("lodash.isempty");
const jsondiffpatch = require("../src/diffpatch").create();

const COMMANDS = require("../index").COMMANDS;
const Client = require("../index").Client;

describe("DiffSync Client", () => {

    function testClient() {
        return new Client({
            emit: Function.prototype,
            on: Function.prototype,
            id: "1"
        }, "testroom");
    }

    function testData() {
        return { a: 1, b: [{ c: 1 }] };
    }

    describe("constructor", () => {

        it("should throw if no socket passed", () => {
            assert.throws(() => new Client(), Error);
            assert.doesNotThrow(() => testClient());
        });

        it("should set a default room", () => {
            assert.notStrictEqual(testClient().room, null);
            assert.notStrictEqual(testClient().room, undefined);
        });

        it("should apply the correct options to jsondiffpatch", () => {
            const client = new Client({}, 1, {
                textDiff: {
                    minLength: 2
                }
            });

            assert(client.jsondiffpatch.options().textDiff.minLength === 2);
        });
    });

    describe("initialize", () => {

        it("should connect to the correct room", () => {
            const c = testClient();
            const spy = sinon.spy(c.socket, "emit");

            c.initialize();

            assert(spy.called);
            assert(spy.calledWith(COMMANDS.join, c.room));
        });
    });

    describe("onRemoteUpdate", () => {

        let client;
        beforeEach(() => (client = testClient()));

        it("should not schedule if update comes from the same client", () => {
            const scheduleSpy = sinon.stub(client, "schedule", Function.prototype);

            // 1 is the id of the local client
            client.onRemoteUpdate("1");

            assert(!scheduleSpy.called);
        });

        it("should schedule if update comes from another client", () => {
            const scheduleSpy = sinon.stub(client, "schedule", Function.prototype);

            client.onRemoteUpdate("2");

            assert(scheduleSpy.called);
        });
    });

    describe("getData", () => {

        it("should return the correct object", () => {
            const client = testClient();

            assert.deepEqual(client.doc.localCopy, client.getData());
            assert.strictEqual(client.doc.localCopy, client.getData());
        });
    });

    describe("_onConnected", () => {

        let client;
        beforeEach(() => (client = testClient()));

        it("should set the model in initialized state", () => {
            assert(!client.initialized);
            client._onConnected({});
            assert(client.initialized);
        });

        it("should release the sync cycle", () => {
            client.initialize();
            assert(client.syncing);
            client._onConnected({});
            assert(!client.syncing);
        });

        it("should subscribe to server sync requests", () => {
            const spy = sinon.spy(client.socket, "on");

            client._onConnected({});
            assert(spy.calledWith(COMMANDS.remoteUpdateIncoming, client.onRemoteUpdate));
        });

        it("should set the shadow and the local copy correctly", () => {
            client._onConnected({
                test: true,
                arr: [{
                    a: 1
                }]
            });
            assert.deepEqual(client.doc.localCopy, client.doc.shadow, "both versions should be identical by value");
            assert.notStrictEqual(client.doc.localCopy, client.doc.shadow, "they shouldnt be the same reference");
        });

        it("should emit the `connected` event", () => {
            const emitSpy = sinon.spy(client, "emit");
            const listenerSpy = sinon.spy();

            client.on("connected", listenerSpy);
            client._onConnected({});

            assert(emitSpy.calledOnce);
            assert(listenerSpy.calledOnce);
        });
    });

    describe("schedule", () => {

        let client;
        beforeEach(() => {
            client = testClient();
        });

        it("should schedule a sync", () => {
            assert(!client.scheduled);
            client.schedule();
            assert(client.scheduled);
        });

        it("should try to sync", () => {
            const spy = sinon.spy(client, "syncWithServer");
            client.schedule();
            assert(spy.calledOnce);
        });
    });

    describe("createDiff", () => {

        it("should create an empty diff for equal objects", () => {
            const a = {
                test: true
            };
            const b = {
                test: true
            };
            const diff = testClient().createDiff(a, b);

            assert(isEmpty(diff));
        });

        it("should create an not empty diff for equal objects", () => {
            const a = {
                test: true,
                test2: true
            };
            const b = {
                test: true
            };
            const diff = testClient().createDiff(a, b);

            assert(!isEmpty(diff));
        });
    });

    describe("createDiffMessage", () => {

        it("should create a valid diff object", () => {
            const client = testClient();
            const serverVersion = client.doc.serverVersion;
            const diff = {};
            const baseVersion = 1;
            const diffMessage = client.createDiffMessage(diff, baseVersion);

            assert.strictEqual(diffMessage.serverVersion, serverVersion);
            assert.strictEqual(diffMessage.localVersion, baseVersion);
            assert.strictEqual(diffMessage.diff, diff);
        });
    });


    describe("createEditMessage", () => {

        it("should create a valid edit message", () => {
            const client = testClient();
            const baseVersion = 1;
            const editMessage = client.createEditMessage(baseVersion);

            assert.equal(editMessage.room, client.room);
            assert.equal(editMessage.localVersion, baseVersion);
            assert.equal(editMessage.serverVersion, client.doc.serverVersion);
            assert.equal(editMessage.edits, client.doc.edits);
        });
    });

    describe("syncWithServer", () => {
        let client;
        let data;
        beforeEach(() => {
            data = testData();
            client = testClient();
            client._onConnected(data);
        });

        function changeLocalDoc() {
            client.doc.localCopy.b[0].c = 2;
        }

        it("should not sync if not initalized", () => {
            client.initialized = false;
            assert.equal(false, client.syncWithServer());
        });

        it("should not sync if currently syncing", () => {
            client.syncing = true;
            assert.equal(false, client.syncWithServer());
        });

        it("should reset the scheduled flag", () => {
            client.scheduled = true;
            changeLocalDoc();
            client.syncWithServer();
            assert.equal(false, client.scheduled);
        });

        it("should set syncing flag", () => {
            assert(!client.syncing);
            changeLocalDoc();
            client.syncWithServer();
            assert(client.syncing);
        });

        it("should perform a valid client-sync circle init", () => {
            const createDiff = sinon.spy(client, "createDiff");
            const createDiffMessage = sinon.spy(client, "createDiffMessage");
            const createEditMessage = sinon.spy(client, "createEditMessage");
            const applyPatchTo = sinon.spy(client, "applyPatchTo");
            const sendEdits = sinon.spy(client, "sendEdits");
            const localVersionBeforeChange = client.doc.localVersion;

            // assert correct version
            assert.equal(client.doc.localVersion, 0, "initial version number is 0");

            // change local version
            client.doc.localCopy.b[0].c = 2;
            client.syncWithServer();

            // creates a diff from shadow and local copy
            assert(createDiff.called, "calls createDiff");
            assert(createDiff.calledWithExactly(client.doc.shadow, client.doc.localCopy), "createDiff called with correct objects");

            // creates a diff message from that diff
            assert(createDiffMessage.calledAfter(createDiff), "calls createDiffMessage after createDiff");

            // creates and edit message from that diff with correct local version
            assert(createEditMessage.calledAfter(createDiffMessage), "calls createEditMessage after createDiffMessage");
            assert(createEditMessage.calledWithExactly(localVersionBeforeChange), "createEditMessage is called with correct local version from before the change");

            // applies patch to shadow
            assert(applyPatchTo.calledAfter(createEditMessage), "calls applyPatchTo after createEditMessage");
            assert.deepEqual(client.doc.shadow, client.doc.localCopy, "applyPatchTo creates deep equality");

            assert.notStrictEqual(client.doc.shadow, client.doc.localCopy, "shadow and local copy are equal, but not same references");
            assert.notStrictEqual(client.doc.shadow.b, client.doc.localCopy.b, "shadow and local copy are equal, but not same references");
            assert.notStrictEqual(client.doc.shadow.b[0], client.doc.localCopy.b[0], "shadow and local copy are equal, but not same references");

            // send the edits to the server
            assert(sendEdits.calledAfter(applyPatchTo), "calls sendEdits after applyPatchTo");

            // assert correctly updated local version number
            assert.equal(client.doc.localVersion, 1, "updated version number is 1");
        });
    });

    describe("applyServerEdits", () => {
        let client;
        beforeEach(() => {
            client = testClient();
            client.on("error", Function.prototype);
        });

        it("resets the syncing flag", () => {
            client.syncing = true;
            client.applyServerEdits();

            assert(!client.syncing);
        });

        it("inits a new sync cycle only if scheduled flag is set", () => {
            const spy = sinon.spy(client, "syncWithServer");

            client.applyServerEdits();

            assert(!spy.called);

            client.scheduled = true;
            client.applyServerEdits();

            assert(spy.called);
        });

        it("calls error callback if `local` version numbers do not match", () => {
            const emitSpy = sinon.spy(client, "emit");
            const listenerSpy = sinon.spy();

            client.on("error", listenerSpy);
            client.doc.localVersion = 1;
            client.applyServerEdits({
                localVersion: 0
            });

            assert(emitSpy.called);
            assert(listenerSpy.called);
        });

        it("calls `applyServerEdit` for each edit", () => {
            const spy = sinon.spy(client, "applyServerEdit");

            client.applyServerEdits({
                localVersion: 0,
                edits: [{
                    a: 1
                }, {
                    b: 1
                }]
            });

            assert(spy.calledTwice);
        });

        it("resets the local edits list", () => {
            // too lazy to add real diffs here
            client.applyServerEdit = Function.prototype;

            client.doc.edits = [{}];
            client.applyServerEdits({
                localVersion: 0,
                edits: [{
                    a: 1
                }, {
                    b: 1
                }]
            });

            assert(client.doc.edits.length === 0);
        });

        it("emits `synced` event after applying all updates", () => {
            const emitSpy = sinon.spy(client, "emit");
            const listenerSpy = sinon.spy();

            client.on("synced", listenerSpy);
            client.applyServerEdits({
                localVersion: 0,
                edits: [{
                    a: 1
                }, {
                    b: 1
                }]
            });

            assert(emitSpy.calledWithExactly("synced"));
            assert(listenerSpy.called);
        });
    });

    describe("applyServerEdit", () => {
        let client;
        let edit;
        let diff;
        let serverData;
        let emptyDiff;

        beforeEach(() => {
            client = testClient();
            client._onConnected(testData());
            serverData = testData();
            serverData.b[0].c = 2;
            serverData.b.push({
                newObject: true
            });

            diff = JSON.parse(JSON.stringify(jsondiffpatch.diff(client.doc.localCopy, serverData)));
            edit = {
                localVersion: client.doc.localVersion,
                serverVersion: client.doc.serverVersion,
                diff
            };

            emptyDiff = jsondiffpatch.diff({}, {});
        });

        it("should apply the server changes and copy all values", () => {
            assert.notEqual(client.doc.localCopy.b[0].c, serverData.b[0].c, "local version and remote version differ");

            const success = client.applyServerEdit(edit);

            assert(success, "a valid edit has been applied");
            assert.equal(client.doc.localCopy.b[0].c, serverData.b[0].c, "local version and remote version are equal");
            assert.deepEqual(client.doc.localCopy, client.doc.shadow, "local version and shadow version are deep equal");
            assert.notStrictEqual(client.doc.localCopy.b[0], client.doc.shadow.b[0], "local version and shadow version are not the same references");
            assert.deepEqual(client.doc.localCopy.b[1], client.doc.shadow.b[1], "local version and shadow version are not the same references");
            assert.notStrictEqual(client.doc.localCopy.b[1], client.doc.shadow.b[1], "local version and shadow version are not the same references");
        });

        it("should reject edits with wrong version numbers", () => {
            assert.notEqual(client.doc.localCopy.b[0].c, serverData.b[0].c, "local version and remote version differ");

            edit.localVersion = client.doc.localVersion + 1;
            const success = client.applyServerEdit(edit);

            assert.notEqual(client.doc.localCopy.b[0].c, serverData.b[0].c, "local version and remote version still differ");
            assert(!success, "the edit is invalid");
        });

        it("updates the server version if diff was not empty", () => {
            const serverVersion = client.doc.serverVersion;

            client.applyServerEdit(edit);

            assert(client.doc.serverVersion === (serverVersion + 1));
        });

        it("does not update the server version if diff was empty", () => {
            const serverVersion = client.doc.serverVersion;

            edit.diff = emptyDiff;
            client.applyServerEdit(edit);

            assert(client.doc.serverVersion === serverVersion);
        });
    });

});
