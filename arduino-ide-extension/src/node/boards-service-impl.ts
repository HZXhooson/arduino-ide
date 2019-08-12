import * as PQueue from 'p-queue';
import { injectable, inject, postConstruct, named } from 'inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { BoardsService, AttachedSerialBoard, BoardPackage, Board, AttachedNetworkBoard, BoardsServiceClient } from '../common/protocol/boards-service';
import { PlatformSearchReq, PlatformSearchResp, PlatformInstallReq, PlatformInstallResp, PlatformListReq, PlatformListResp } from './cli-protocol/commands/core_pb';
import { CoreClientProvider } from './core-client-provider';
import { BoardListReq, BoardListResp } from './cli-protocol/commands/board_pb';
import { ToolOutputServiceServer } from '../common/protocol/tool-output-service';

@injectable()
export class BoardsServiceImpl implements BoardsService {

    @inject(ILogger)
    @named('discovery')
    protected discoveryLogger: ILogger;

    @inject(CoreClientProvider)
    protected readonly coreClientProvider: CoreClientProvider;

    @inject(ToolOutputServiceServer)
    protected readonly toolOutputService: ToolOutputServiceServer;

    protected selectedBoard: Board | undefined;
    protected discoveryInitialized = false;
    protected discoveryTimer: NodeJS.Timeout | undefined;
    /**
     * Poor man's serial discovery:
     * Stores the state of the currently discovered, attached boards.
     * This state is updated via periodical polls.
     */
    protected _attachedBoards: { boards: Board[] } = { boards: [] };
    protected client: BoardsServiceClient | undefined;
    protected readonly queue = new PQueue({ autoStart: true, concurrency: 1 });

    @postConstruct()
    protected async init(): Promise<void> {
        this.discoveryTimer = setInterval(() => {
            this.discoveryLogger.trace('Discovering attached boards...');
            this.doGetAttachedBoards().then(({ boards }) => {
                const update = (oldState: Board[], newState: Board[], message: string) => {
                    this._attachedBoards = { boards: newState };
                    this.discoveryLogger.info(`${message} - Discovered boards: ${JSON.stringify(newState)}`);
                    if (this.client) {
                        this.client.notifyAttachedBoardsChanged({
                            oldState: {
                                boards: oldState
                            },
                            newState: {
                                boards: newState
                            }
                        });
                    }
                }
                const sortedBoards = boards.sort(Board.compare);
                this.discoveryLogger.trace(`Discovery done. ${JSON.stringify(sortedBoards)}`);
                if (!this.discoveryInitialized) {
                    update([], sortedBoards, 'Initialized attached boards.');
                    this.discoveryInitialized = true;
                } else {
                    this.getAttachedBoards().then(({ boards: currentBoards }) => {
                        this.discoveryLogger.trace(`Updating discovered boards... ${JSON.stringify(currentBoards)}`);
                        if (currentBoards.length !== sortedBoards.length) {
                            update(currentBoards, sortedBoards, 'Updated discovered boards.');
                            return;
                        }
                        // `currentBoards` is already sorted.
                        for (let i = 0; i < sortedBoards.length; i++) {
                            if (Board.compare(sortedBoards[i], currentBoards[i]) !== 0) {
                                update(currentBoards, sortedBoards, 'Updated discovered boards.');
                                return;
                            }
                        }
                        this.discoveryLogger.trace('No new boards were discovered.');
                    });
                }
            });
        }, 1000);
    }

    setClient(client: BoardsServiceClient | undefined): void {
        this.client = client;
    }

    dispose(): void {
        if (this.discoveryTimer !== undefined) {
            clearInterval(this.discoveryTimer);
        }
    }

    async getAttachedBoards(): Promise<{ boards: Board[] }> {
        return this._attachedBoards;
    }

    private async doGetAttachedBoards(): Promise<{ boards: Board[] }> {
        return this.queue.add(() => {
            return new Promise<{ boards: Board[] }>(async resolve => {
                const coreClient = await this.coreClientProvider.getClient();
                const boards: Board[] = [];
                if (!coreClient) {
                    resolve({ boards });
                    return;
                }

                const { client, instance } = coreClient;
                const req = new BoardListReq();
                req.setInstance(instance);
                const resp = await new Promise<BoardListResp>((resolve, reject) => client.boardList(req, (err, resp) => (!!err ? reject : resolve)(!!err ? err : resp)));
                for (const portsList of resp.getPortsList()) {
                    const protocol = portsList.getProtocol();
                    const address = portsList.getAddress();
                    for (const board of portsList.getBoardsList()) {
                        const name = board.getName() || 'unknown';
                        const fqbn = board.getFqbn();
                        const port = address;
                        if (protocol === 'serial') {
                            boards.push(<AttachedSerialBoard>{
                                name,
                                fqbn,
                                port
                            });
                        } else { // We assume, it is a `network` board.
                            boards.push(<AttachedNetworkBoard>{
                                name,
                                fqbn,
                                address,
                                port
                            });
                        }
                    }
                }
                // TODO: remove mock board!
                // boards.push(...[
                //     <AttachedSerialBoard>{ name: 'Arduino/Genuino Uno', fqbn: 'arduino:avr:uno', port: '/dev/cu.usbmodem14201' },
                //     <AttachedSerialBoard>{ name: 'Arduino/Genuino Uno', fqbn: 'arduino:avr:uno', port: '/dev/cu.usbmodem142xx' },
                // ]);
                resolve({ boards });
            })
        });
    }

    async search(options: { query?: string }): Promise<{ items: BoardPackage[] }> {
        const coreClient = await this.coreClientProvider.getClient();
        if (!coreClient) {
            return { items: [] };
        }
        const { client, instance } = coreClient;

        const installedPlatformsReq = new PlatformListReq();
        installedPlatformsReq.setInstance(instance);
        const installedPlatformsResp = await new Promise<PlatformListResp>((resolve, reject) =>
            client.platformList(installedPlatformsReq, (err, resp) => (!!err ? reject : resolve)(!!err ? err : resp))
        );
        const installedPlatforms = installedPlatformsResp.getInstalledPlatformList();

        const req = new PlatformSearchReq();
        req.setSearchArgs(options.query || "");
        req.setInstance(instance);
        const resp = await new Promise<PlatformSearchResp>((resolve, reject) => client.platformSearch(req, (err, resp) => (!!err ? reject : resolve)(!!err ? err : resp)));

        let items = resp.getSearchOutputList().map(item => {
            let installedVersion: string | undefined;
            const matchingPlatform = installedPlatforms.find(ip => ip.getId() === item.getId());
            if (!!matchingPlatform) {
                installedVersion = matchingPlatform.getInstalled();
            }

            const result: BoardPackage = {
                id: item.getId(),
                name: item.getName(),
                author: item.getMaintainer(),
                availableVersions: [item.getLatest()],
                description: item.getBoardsList().map(b => b.getName()).join(", "),
                installable: true,
                summary: "Boards included in this package:",
                installedVersion,
                boards: item.getBoardsList().map(b => <Board>{ name: b.getName(), fqbn: b.getFqbn() }),
                moreInfoLink: item.getWebsite()
            }
            return result;
        });

        return { items };
    }

    async install(pkg: BoardPackage): Promise<void> {
        const coreClient = await this.coreClientProvider.getClient();
        if (!coreClient) {
            return;
        }
        const { client, instance } = coreClient;

        const [platform, boardName] = pkg.id.split(":");

        const req = new PlatformInstallReq();
        req.setInstance(instance);
        req.setArchitecture(boardName);
        req.setPlatformPackage(platform);
        req.setVersion(pkg.availableVersions[0]);

        console.info("Starting board installation", pkg);
        const resp = client.platformInstall(req);
        resp.on('data', (r: PlatformInstallResp) => {
            const prog = r.getProgress();
            if (prog && prog.getFile()) {
                this.toolOutputService.publishNewOutput("board download", `downloading ${prog.getFile()}\n`)
            }
        });
        await new Promise<void>((resolve, reject) => {
            resp.on('end', resolve);
            resp.on('error', reject);
        });
        if (this.client) {
            this.client.notifyBoardInstalled({ pkg });
        }
        console.info("Board installation done", pkg);
    }

}
