const assert = require("assert");
const sinon = require("sinon");
const Server = require("../../server");
const Client = require("../../client");
const Adapter = require("../../server/adapter/InMemoryDataAdapter");
const COMMANDS = require("../../lib/commands");
const EventEmitter = require("events").EventEmitter;


describe("client server communication", () => {

    let client;
    let server;
    let room;

    function createServer() {
        room = [];
        function emitToRoom(...args) {
            room.forEach((socket) => socket.emit(...args));
        }
        const transport = new EventEmitter();
        transport.to = (roomId) => ({ emit: emitToRoom }); // eslint-disable-line no-unused-vars
        return new Server(transport, new Adapter());
    }

    function createClient(serverInstance, id = "1", roomId = "test-room") {
        const clientSocket = Object.assign(new EventEmitter(), { id, join: Function.prototype });
        room.push(clientSocket);
        serverInstance.transport.emit("connection", clientSocket);
        return new Client(clientSocket, roomId);
    }

    beforeEach(() => {
        server = createServer();
        client = createClient(server);
    });


    it("client should join with server", () => {
        const flowSpy = sinon.spy();
        // server listens to this event
        client.socket.on(COMMANDS.join, flowSpy);
        // emitted when server has called the client-cb from join
        client.on(Client.EVENTS.CONNECTED, flowSpy);

        return client
            .join()
            .then(() => assert(flowSpy.calledTwice));
    });

    it("client-server should perform a sync cycle", (done) => {
        const flowSpy = sinon.spy();
        // emitted by client to sync with server
        client.socket.on(COMMANDS.syncWithServer, flowSpy);
        // emitted by server when changes have been applied. Which should be ignored by client intiating the request
        client.socket.on(COMMANDS.remoteUpdateIncoming, flowSpy);
        // called when server and client have synched their changes
        client.on(Client.EVENTS.SYNCED, flowSpy);

        client.join()
            .then(() => {
                // make some changes
                const data = client.getData();
                data.data = { id: "my-test-data" };
                // starts test relevant procedure
                client.sync();
            });

        client.on(Client.EVENTS.SYNCED, () => {
            assert(flowSpy.calledThrice);
            done();
        });
    });

    it("client should receive updates from different clients", (done) => {
        const flowSpy = sinon.spy();
        let clientsReady = 0;
        const theOtherClient = createClient(server, "2");
        // connect clients
        client.on(Client.EVENTS.CONNECTED, onConnect);
        theOtherClient.on(Client.EVENTS.CONNECTED, onConnect);

        function onConnect() {
            clientsReady += 1;
            if (clientsReady === 2) {
                const data = theOtherClient.getData();
                data.data = { id: "their-test-data" };

                // emitted by server to request a sync cycle
                client.socket.on(COMMANDS.remoteUpdateIncoming, flowSpy);
                // emitted by client to sync with server
                client.socket.on(COMMANDS.syncWithServer, flowSpy);
                // called when server and client have synched their changes
                client.on(Client.EVENTS.SYNCED, flowSpy);

                // starts test relevant procedure
                theOtherClient.sync();
            }
        }

        client.on(Client.EVENTS.SYNCED, () => {
            assert(flowSpy.callCount === 3);
            done();
        });

        client.join();
        setTimeout(() => theOtherClient.join()); // currently multiple users can not join within the same tick
    });
});
