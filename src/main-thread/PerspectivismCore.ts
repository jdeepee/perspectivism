import * as Config from './Config'
import * as Db from './db'
import type { PerspectivismDb } from './db'
import * as Holochain from './Holochain'
import * as IPFS from './IPFS'
import AgentService from './AgentService'
import PerspectivesController from './PerspectivesController'
import LinkRepoController from './LinkRepoController'
import LanguageController from './LanguageController'
import * as GraphQL from './GraphQL'
import * as DIDs from './DIDs'
import type { DIDResolver } from './DIDs'
import Signatures from './Signatures'


export default class PerspectivismCore {
    #holochain: any
    #IPFS: any

    #agentService: AgentService
    #db: PerspectivismDb
    #didResolver: DIDResolver
    #signatures: Signatures

    #perspectivesController: PerspectivesController
    #languageController: LanguageController
    #linkRepoController: LinkRepoController

    constructor() {
        Config.init()
        
        this.#agentService = new AgentService(Config.rootConfigPath)
        this.#agentService.load()
        this.#db = Db.init(Config.dataPath)
        this.#didResolver = DIDs.init(Config.dataPath)
        this.#signatures = new Signatures(this.#didResolver)
    }

    get agentService(): AgentService {
        return this.#agentService
    }

    get perspectivesController(): PerspectivesController {
        return this.#perspectivesController
    }

    get languageController(): LanguageController {
        return this.#languageController
    }

    get linkRepoController(): LinkRepoController {
        return this.#linkRepoController
    }

    async startGraphQLServer() {
        const { url, subscriptionsUrl } = await GraphQL.startServer(this)
        console.log(`🚀  GraphQL Server ready at ${url}`)
        console.log(`🚀  GraphQL subscriptions ready at ${subscriptionsUrl}`)
    }

    async initServices() {
        this.#holochain = Holochain.init(Config.holochainConfigPath, Config.holochainDataPath)
        this.#IPFS = await IPFS.init()
    }

    async waitForAgent(): Promise<void> {
        return this.#agentService.ready
    }

    initControllers() {
        this.#perspectivesController = new PerspectivesController(Config.rootConfigPath)
        this.#languageController = new LanguageController({
            agent: this.#agentService,
            IPFS: this.#IPFS,
            signatures: this.#signatures
        }, this.#holochain)
        this.#linkRepoController = new LinkRepoController({
            db: this.#db, 
            languageController: this.#languageController, 
            agent: this.#agentService
        })
    }
}

export function create(): PerspectivismCore {
    return new PerspectivismCore()
}