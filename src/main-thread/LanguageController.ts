import type Expression from '../acai/Expression';
import ExpressionRef from '../acai/ExpressionRef';
import type Language from '../acai/Language'
import type { LinksAdapter } from '../acai/Language'
import type { InteractionCall } from '../acai/Language'
import type LanguageContext from '../acai/LanguageContext';
import type LanguageRef from '../acai/LanguageRef'
import fs from 'fs'
import path from 'path'
import multihashing from 'multihashing'
import multihashes from 'multihashes'
import * as Config from './Config'
import type { HolochainService } from './Holochain';
import type AgentService from './AgentService'

const builtInLanguages = [
    'note-ipfs',
    'url-iframe',
    //'gun-links',
    'ipfs-links',
    'junto-hc-shortform',
    'agent-profiles'
].map(l => `./src/languages/${l}/build/bundle.js`)

const aliases = {
    'http': 'url-iframe',
    'https': 'url-iframe',
    'did': 'agent-profiles'
}

type LinkObservers = (added: Expression[], removed: Expression[], lang: LanguageRef)=>void;

export class LanguageController {
    #languages: Map<string, Language>
    #languageConstructors: Map<string, (LanguageContext)=>Language>
    #context: object;
    #linkObservers: LinkObservers[];


    constructor(context: object, holochainService: HolochainService) {
        this.#context = context
        this.#languages = new Map()
        this.#languageConstructors = new Map()
        this.#linkObservers = []

        builtInLanguages.forEach( bundle => {
            const bundleBytes = fs.readFileSync(bundle)
            const hash = multihashes.toHexString(multihashing(bundleBytes, 'sha2-256'))
            const { default: create, name } = require(path.join(process.env.PWD, bundle))

            const customSettings = this.getSettings({name, address: hash} as LanguageRef)
            const storageDirectory = Config.getLanguageStoragePath(name)
            const Holochain = holochainService.getDelegateForLanguage(hash)
            const language = create({...context, customSettings, storageDirectory, Holochain})

            let isAgentLanguage = false
            Object.keys(aliases).forEach(alias => {
                if(language.name === aliases[alias]) {
                    aliases[alias] = hash
                    if(alias === 'did') {
                        isAgentLanguage = true
                    }
                }
            })

            if(language.linksAdapter) {
                language.linksAdapter.addCallback((added, removed) => {
                    this.#linkObservers.forEach(o => {
                        o(added, removed, {name, address: hash} as LanguageRef)
                    })
                })
            }

            this.#languages.set(hash, language)
            this.#languageConstructors.set(hash, create)

            if(isAgentLanguage) {
                ((context as LanguageContext).agent as AgentService).setAgentLanguage(language)
            }
        })
    }

    private languageForExpression(e: ExpressionRef): Language {
        const address = aliases[e.language.address] ? aliases[e.language.address] : e.language.address
        const language = this.#languages.get(address)
        if(language) {
            return language
        } else {
            throw new Error("Language for expression not found: " + JSON.stringify(e))
        }
    }

    languageByRef(ref: LanguageRef): Language {
        const address = aliases[ref.address] ? aliases[ref.address] : ref.address
        const language = this.#languages.get(address)
        if(language) {
            return language
        } else {
            throw new Error("Language not found by reference: " + JSON.stringify(ref))
        }
    }

    filteredLanguageRefs(propertyFilter: void | string): LanguageRef[] {
        const refs: LanguageRef[] = []
        this.#languages.forEach((language, hash) => {
            if(!propertyFilter || Object.keys(language).includes(propertyFilter)) {
                refs.push({
                    address: hash,
                    name: language.name,
                })
            }
        })
        return refs
    }

    getInstalledLanguages(): LanguageRef[] {
        return this.filteredLanguageRefs()
    }

    getLanguagesWithExpressionUI(): LanguageRef[] {
        return this.filteredLanguageRefs("expressionUI")
    }

    getLanguagesWithLinksAdapter(): LanguageRef[] {
        return this.filteredLanguageRefs("linksAdapter")
    }

    getConstructorIcon(lang: LanguageRef): void | string {
        return this.languageByRef(lang).expressionUI?.constructorIcon()
    }

    getSettingsIcon(lang: LanguageRef): void | string {
        return this.languageByRef(lang).settingsUI?.settingsIcon()
    }

    getIcon(lang: LanguageRef): void | string {
        return  this.languageByRef(lang).expressionUI?.icon()
    }

    getSettings(lang: LanguageRef): object {
        const FILEPATH = path.join(Config.languagesPath, lang.name, 'settings.json')
        if(fs.existsSync(FILEPATH)) {
            return JSON.parse(fs.readFileSync(FILEPATH).toString())
        } else {
            return {}
        }
    }

    putSettings(lang: LanguageRef, settings: object) {
        const directory = path.join(Config.languagesPath, lang.name)
        if(!fs.existsSync(directory))
            fs.mkdirSync(directory)
        const FILEPATH = path.join(directory, 'settings.json')
        fs.writeFileSync(FILEPATH, JSON.stringify(settings))

        this.#languages.set(lang.address, null)
        const create = this.#languageConstructors.get(lang.address)
        const context = this.#context
        const storageDirectory = Config.getLanguageStoragePath(lang.name)
        const newInstance = create({...context, storageDirectory, customSettings: settings})
        this.#languages.set(lang.address, newInstance)
    }

    async createPublicExpression(lang: LanguageRef, content: object): Promise<ExpressionRef> {
        const putAdapter = this.languageByRef(lang).expressionAdapter.putAdapter
        let address = null

        try {
            // Ok, first we assume its a PublicSharing put adapter...
            // @ts-ignore
            address = await putAdapter.createPublic(content)
        } catch(e1) {
            try {
                // ...and if it's not, let's try to treat it like a
                // ReadOnlyLangauge..
                // @ts-ignore
                address = await putAdapter.addressOf(content)
            } catch(e2) {
                // If both don't work, we don't know what to do with this put adapter :/
                throw new Error(`Incompatible putAdapter in Languge ${JSON.stringify(lang)}\nPutAdapter: ${Object.keys(putAdapter)}\nError was: ${e1.toString()}\nand: ${e2.toString()}`)
            }
        }

        return new ExpressionRef(lang, address)
    }

    async getExpression(ref: ExpressionRef): Promise<void | Expression> {
        const expr = await this.languageForExpression(ref).expressionAdapter.get(ref.expression)
        if(expr) {
            try{
                // @ts-ignore
                if(! await this.#context.signatures.verify(expr)) {
                    console.error("BROKEN SIGNATURE FOR EXPRESSION:", expr)
                } else {
                    console.debug("Valid expr:", ref)
                }
            } catch(e) {
                console.error("Error trying to verify expression signature:", e)
                console.error("For expression:", expr)
            }
            
        }
        return expr
    }

    interact(expression: ExpressionRef, interaction: InteractionCall) {
        console.log("TODO")
    }

    getLinksAdapter(lang: LanguageRef): void | LinksAdapter {
        return this.languageByRef(lang).linksAdapter
    }

    addLinkObserver(observer) {
        this.#linkObservers.push(observer)
    }
}

export function init(context: object, holochainService: HolochainService): LanguageController {
    const languageController = new LanguageController(context, holochainService)
    return languageController
}