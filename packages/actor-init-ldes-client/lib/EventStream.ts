import { ActionContext, Actor, IActorTest, Mediator } from "@comunica/core";
import {
    IActionRdfMetadataExtract,
    IActorRdfMetadataExtractOutput,
    ActorRdfMetadataExtract
} from '@comunica/bus-rdf-metadata-extract';
import { MediatorRdfParseHandle } from "@comunica/bus-rdf-parse";
import { MediatorRdfSerializeHandle } from '@comunica/bus-rdf-serialize';
import { IActionRdfFrame, IActorRdfFrameOutput } from "@treecg/bus-rdf-frame";
import { Member, Logger } from "@treecg/types";
import { Quad } from "@rdfjs/types";
import LRU from 'lru-cache';
import { Readable } from 'readable-stream';
import { AsyncIterator, ArrayIterator } from "asynciterator";
import { Frame } from "jsonld/jsonld-spec";
import { inspect } from 'util';
import { DataFactory } from 'rdf-data-factory';
import { JsonLdDocument } from "jsonld";
import * as ContentType from 'content-type';
import * as CachePolicy from 'http-cache-semantics';
import * as moment from 'moment';
import * as RDF from 'rdf-js';
import * as f from "@dexagod/rdf-retrieval";
import * as RdfString from "rdf-string";
import { Bookkeeper, SerializedBookkeper } from './Bookkeeper';
import RateLimiter from "./RateLimiter";
import MemberIterator from "./MemberIterator";

const stringifyStream = require('stream-to-string');
const streamifyString = require('streamify-string');

export enum OutputRepresentation {
    Quads = "Quads",
    Object = "Object"
}

export interface IEventStreamArgs {
    pollingInterval?: number,
    representation?: OutputRepresentation,
    requestHeaders?: { [key: string]: number | string | string[] },
    mimeType?: string,
    jsonLdContext?: JsonLdDocument,
    fromTime?: Date,
    emitMemberOnce?: boolean,
    disablePolling?: boolean,
    disableSynchronization?: boolean,
    disableFraming?: boolean,
    dereferenceMembers?: boolean,
    requestsPerMinute?: number,
    loggingLevel?: string,
    processedURIsCount?: number,
}

export interface IEventStreamMediators {
    mediatorRdfMetadataExtract: Mediator<ActorRdfMetadataExtract,
        IActionRdfMetadataExtract, IActorTest, IActorRdfMetadataExtractOutput>;

    mediatorRdfParseHandle: MediatorRdfParseHandle;

    mediatorRdfFrame: Mediator<Actor<IActionRdfFrame, IActorTest, IActorRdfFrameOutput>,
        IActionRdfFrame, IActorTest, IActorRdfFrameOutput>;

    mediatorRdfSerializeHandle: MediatorRdfSerializeHandle;
}

interface IMember {
    uri: string,
    quads: RDF.Stream<RDF.Quad> & AsyncIterator<RDF.Quad>,
}

export class EventStream extends Readable {
    protected readonly mediators: IEventStreamMediators;

    protected readonly pollingInterval?: number;
    protected readonly representation?: OutputRepresentation;
    protected readonly requestHeaders?: { [key: string]: number | string | string[] };
    protected readonly mimeType?: string;
    protected readonly jsonLdContext?: JsonLdDocument;
    protected readonly emitMemberOnce?: boolean;
    protected readonly fromTime?: Date;
    protected readonly disableSynchronization?: boolean;
    protected readonly disableFraming?: boolean;
    protected readonly dereferenceMembers?: boolean;
    protected readonly accessUrl: string;
    protected readonly logger: Logger;
    protected readonly processedURIsCount?: number;
    protected readonly bookkeeper: Bookkeeper;
    protected readonly rateLimiter: RateLimiter;
    protected processedURIs: any;
    protected timeout: any;

    private downloading: boolean;
    private syncingmode: boolean;
    private paused: boolean = false;


    public constructor(
        url: string,
        mediators: IEventStreamMediators,
        args: IEventStreamArgs,
        state: State | null
    ) {
        super({ objectMode: true, highWaterMark: 1000 });

        this.mediators = mediators;
        this.accessUrl = url;
        this.fromTime = args.fromTime;
        this.disableSynchronization = args.disableSynchronization;
        this.disableFraming = args.disableFraming;
        this.pollingInterval = args.pollingInterval;
        this.representation = args.representation;
        this.requestHeaders = args.requestHeaders;
        this.mimeType = args.mimeType;
        this.jsonLdContext = args.jsonLdContext;
        this.dereferenceMembers = args.dereferenceMembers;
        this.emitMemberOnce = args.emitMemberOnce;
        this.processedURIsCount = args.processedURIsCount!;
        this.processedURIs = new LRU({ max: this.processedURIsCount });
        this.bookkeeper = new Bookkeeper();
        this.logger = new Logger(this, args.loggingLevel);
        this.downloading = false;
        this.syncingmode = false;
        if (args.requestsPerMinute) {
            this.rateLimiter = new RateLimiter(60000. / args.requestsPerMinute);
        } else {
            this.rateLimiter = new RateLimiter(0);
        }
        if (state != null) {
            this.importState(state);
        } else {
            this.bookkeeper.addFragment(this.accessUrl, 0);
        }
    }

    public ignorePages(urls: string[]) {
        for (const url of urls) {
            this.bookkeeper.blacklistFragment(url);
        }
    }

    private async fetchNextPage() {
        this.downloading = true;
        const next = this.bookkeeper.getNextFragmentToFetch();
        const wait = next.refetchTime.getTime() - new Date().getTime();
        // Do not refetch too soon
        if (wait > 0) {
            this.logger.debug(`Waiting ${wait / 1000}s before refetching: ${next.url}`);
            await this.sleep(wait);
        }
        // Retrieve data
        await this.retrieve(next.url);
        this.downloading = false;
        this.emit('page processed', next.url);
        this._read();
    }

    public async _read() {
        try {
            if (!this.downloading && this.paused) {
                // Reading process has been externally paused
                super.pause();
            } else if (!this.downloading && !this.paused && this.bookkeeper.nextFragmentExists()) {
                // Reading process is not paused, is not downloading new data and there is more data available
                if (!this.disableSynchronization && this.bookkeeper.inSyncingMode() && !this.syncingmode) {
                    // We have reached the most recent fragment and synchronization is enabled
                    this.syncingmode = true;
                    this.emit('synchronizing');
                    if (!this.downloading && this.paused) {
                        super.pause();
                    }
                } else {
                    // Proceed and fetch more data
                    await this.fetchNextPage();
                }
            } else if (!this.downloading) {
                //end of the stream
                this.logger.debug("done");
                this.push(null);
            }
        } catch (e) {
            console.error(e);
        }
    }

    protected sleep(ms: number) {
        return new Promise(resolve => {
            this.timeout = setTimeout(resolve, ms);
        });
    }

    public pause(): this {
        this.paused = true;
        return this;
    }

    public resume(): this {
        this.paused = false;
        super.resume();
        return this
    }

    public destroy(): this {
        // Properly close the stream by clearing any pending tasks
        clearTimeout(this.timeout);
        super.destroy();
        return this;
    }

    public exportState(): State {
        if (!this.isPaused() && !this.readableEnded) {
            throw new Error('Cannot export state while stream is not paused or ended');
        }
        let memberBuffer: any = [];
        while (this.readableLength > 0) {
            let member = this.read();
            if (this.representation === OutputRepresentation.Quads) {
                if (member !== null) {
                    let quads = [];
                    for (const quad of member.quads) {
                        quads.push(RdfString.quadToStringQuad(quad));
                    }
                    memberBuffer.push({ id: member.id, quads: quads });
                }
            } else {
                memberBuffer.push(member);
            }
        }
        return {
            bookkeeper: this.bookkeeper.serialize(),
            memberBuffer: JSON.stringify(memberBuffer),
            processedURIs: JSON.stringify(this.processedURIs.dump()),
        };
    }

    public isBuffering(): boolean {
        return this.downloading;
    }

    public importState(state: State) {
        this.bookkeeper.deserialize(state.bookkeeper);

        if (state.memberBuffer != undefined && JSON.parse(state.memberBuffer) != null) {
            if (this.representation === OutputRepresentation.Quads) {
                let internalBuffer = JSON.parse(state.memberBuffer);
                for (const member of internalBuffer) {
                    let quads = [];
                    for (const quad of member.quads) {
                        quads.push(RdfString.stringQuadToQuad(quad));
                    }
                    let _member: Member = { id: member.id, quads: quads };
                    super.unshift(_member);
                }
            } else {
                for (const member of JSON.parse(state.memberBuffer)) {
                    super.unshift(member);
                }
            }
        }

        this.processedURIs = new LRU({ max: this.processedURIsCount! });
        this.processedURIs.load(JSON.parse(state.processedURIs));
    }

    protected async retrieve(pageUrl: string) {
        this.logger.debug(`GET ${pageUrl}`);
        const startTime = new Date();

        await this.rateLimiter.planRequest(pageUrl);

        try {
            const page = await this.getPage(pageUrl);
            this.logger.debug(`${page.statusCode} ${page.url} (${new Date().getTime() - startTime.getTime()}) ms`);

            // Remember that the fragment has been retrieved
            this.processedURIs.set(pageUrl, {});
            this.processedURIs.set(page.url, {}); // can be a redirected response <> pageUrl
            this.logger.debug(page.url + " added to processedURIs");
            this.logger.debug("Size of processedURIs: " + this.processedURIs.length);
            // Retrieve media type
            // TODO: Fetch mediaType by using response and comunica actor
            const mediaType = page.contentType;

            if (!this.disableSynchronization && this.pollingInterval) {
                // Based on the HTTP Caching headers, poll this fragment for synchronization
                // If options.shared is false, then the response is evaluated from a perspective of a single-user cache 
                // (i.e. private is cacheable and s-maxage is ignored)
                const policy = new CachePolicy(page.request, page.response, { shared: false });
                const ttl = Math.max(this.pollingInterval, policy.storable() ? policy.timeToLive() : 0); // pollingInterval is fallback
                this.bookkeeper.addFragment(page.url, ttl);
            }

            const quadsArrayOfPage = await this.stringToQuadArray(page.data.toString(), page.url, mediaType);

            // Parse into RDF Stream to retrieve TREE metadata
            const context = new ActionContext({});
            const treeMetadata = await this.mediators.mediatorRdfMetadataExtract.mediate({
                context: context,
                requestTime: 0,
                metadata: await this.quadArrayToQuadStream(quadsArrayOfPage),
                url: page.url
            });
            this.emit("metadata", { ...treeMetadata.metadata, url: page.url });

            // When there are no tree:relations found, search for a tree:view to continue
            // In this case, we expect that the URL parameter provided contains a tree collection's URI
            if (!treeMetadata.metadata.treeMetadata.relations.size) {
                // Page URL should be a collection URI
                // Check the URL with and without www
                const pageUrlWithoutWWW = pageUrl.replace('://www.', '://');
                if (treeMetadata.metadata.treeMetadata.collections.get(pageUrl)
                    && treeMetadata.metadata.treeMetadata.collections.get(pageUrl)["view"]) {
                    // take first view encountered
                    const view = treeMetadata.metadata.treeMetadata.collections.get(pageUrl)["view"][0]["@id"];
                    this.bookkeeper.addFragment(view, 0);
                } else if (treeMetadata.metadata.treeMetadata.collections.get(pageUrlWithoutWWW)
                    && treeMetadata.metadata.treeMetadata.collections.get(pageUrlWithoutWWW)["view"]) {
                    // take first view encountered
                    const view = treeMetadata.metadata.treeMetadata.collections.get(pageUrlWithoutWWW)["view"][0]["@id"];
                    this.bookkeeper.addFragment(view, 0);
                }
            }

            // Retrieve TREE relations towards other nodes
            for (const [_, relation] of treeMetadata.metadata.treeMetadata.relations) {
                // Prune when the value of the relation is a datetime and less than what we need
                // To be enhanced when more TREE filtering capabilities are available
                if (this.fromTime && relation["@type"][0] === "https://w3id.org/tree#LessThanRelation"
                    && moment(relation.value[0]["@value"]).isValid()
                    && new Date(relation.value[0]["@value"]).getTime() <= this.fromTime.getTime()) {
                    // Prune - do nothing
                } else {
                    // Add node to book keeper with ttl 0 (as soon as possible)
                    for (const node of relation.node) {
                        // do not add when synchronization is disabled and node has already been processed
                        if (!this.disableSynchronization || (this.disableSynchronization && !this.processedURIs.has(node['@id']))) {
                            this.bookkeeper.addFragment(node['@id'], 0);
                        }
                    }
                }
            }

            const memberUris: string[] = this.getMemberUris(treeMetadata);
            const members = this.getMembers(quadsArrayOfPage, memberUris);

            await this.processMembers(members);
        } catch (e) {
            this.logger.error(`Failed to retrieve ${pageUrl}
${inspect(e)}`);
        }
    }

    protected async getPage(pageUrl: string): Promise<PageMetadata> {
        try {
            const req = {
                headers: {
                    'Accept': 'application/ld+json',
                    ...this.requestHeaders
                }
            }
            const res = await fetch(pageUrl, req);
            const resHeaders: Array<[string, string]> = [];
            res.headers.forEach((v, k) => resHeaders.push([k, v]));

            return <PageMetadata>{
                url: res.url,
                request: req,
                response: { status: res.status, headers: Object.fromEntries(resHeaders) },
                statusCode: res.status,
                data: await res.text(),
                contentType: ContentType.parse(<string>res.headers.get('content-type')).type
            };
        } catch (err) {
            this.logger.error(inspect(err));
            throw err;
        }
    }

    protected * getMembers(quads: RDF.Quad[], memberUris: string[]): Generator<IMember> {
        const subjectIndex: Record<string, RDF.Quad[]> = {};
        for (const quad of quads) {
            const subject = quad.subject.value;
            if (!subjectIndex[subject]) {
                subjectIndex[subject] = [quad];
            } else {
                subjectIndex[subject].push(quad);
            }
        }

        const result: Record<string, AsyncIterator<RDF.Quad>> = {};
        for (const memberUri of memberUris) {
            if (this.fromTime) {
                // Check the event time; skip if needed
                const eventTime = this.extractEventTime(subjectIndex[memberUri]);
                if (!eventTime || eventTime < this.fromTime) {
                    continue;
                }
            }

            if (this.emitMemberOnce && this.processedURIs.has(memberUri)) {
                // This event has already been emitted
                continue;
            }

            this.processedURIs.set(memberUri, {});

            if (!this.dereferenceMembers) {
                const done = new Set(memberUris);
                yield this.extractMember(memberUri, subjectIndex, done);
            } else {
                const quads = new MemberIterator(memberUri, this.rateLimiter);
                quads.on('error', (msg, e) => {
                    this.logger.error(msg + '\n' + inspect(e));
                })
                yield {
                    uri: memberUri,
                    quads: quads,
                } as IMember;
            }
        }
        return result;
    }

    protected extractMember(memberUri: string, subjectIndex: Record<string, RDF.Quad[]>, done: Set<string>): IMember {
        const queue: string[] = [memberUri];
        const result: RDF.Quad[] = [];

        while (queue.length > 0) {
            const subject = queue.pop();

            if (!subject) {
                // Type coercion, should never happen
                break;
            }

            if (!subjectIndex[subject]) {
                // Nothing is known about this resource
                continue;
            }

            for (const quad of subjectIndex[subject]) {
                result.push(quad);

                if (quad.object.termType === 'NamedNode' || quad.object.termType === 'BlankNode') {
                    if (!done.has(quad.object.value)) {
                        done.add(quad.object.value);
                        queue.push(quad.object.value);
                    }
                }
            }
        }

        return {
            uri: memberUri,
            quads: new ArrayIterator(result),
        };
    }

    protected async processMembers(members: Generator<IMember>) {
        let factory = new DataFactory();
        for (const member of members) {
            const id = member.uri;
            const quadStream = member.quads;

            try {
                const context = new ActionContext({});
                //If representation is set, let’s return the data without serialization, but in the requested representation (Object or Quads)
                if (this.representation) {
                    //Can be "Object" or "Quads"
                    if (this.representation === OutputRepresentation.Object) {
                        if (!this.disableFraming) {
                            let framedResult = (await this.mediators.mediatorRdfFrame.mediate({
                                context: context,
                                data: quadStream,
                                frames: [{ "@id": id }],
                                jsonLdContext: this.jsonLdContext
                            })).data;
                            let firstEntry = framedResult.entries().next();
                            this.push({ "id": firstEntry.value[0]["@id"], object: firstEntry.value[1] });
                        } else {
                            let result = JSON.parse(await stringifyStream((await this.mediators.mediatorRdfSerializeHandle.mediate({
                                context: context,
                                handle: { quadStream: quadStream, context: context },
                                handleMediaType: "application/ld+json"
                            })).handle.data));
                            this.push({ "id": result[0]["@id"], object: result });
                        }
                    } else {
                        //Build an array from the quads iterator
                        await new Promise<void>((resolve, reject) => {
                            let quadArray: Array<Quad> = [];
                            quadStream.forEach((item) => {
                                quadArray.push(item);
                            });
                            quadStream.on('end', () => {
                                let _member: Member = {
                                    id: factory.namedNode(member.uri),
                                    quads: quadArray
                                };
                                this.push(_member);
                                resolve();
                            });
                        });
                    }
                } else {
                    let outputString;
                    if (this.mimeType != "application/ld+json" || this.disableFraming) {
                        outputString = await stringifyStream((await this.mediators.mediatorRdfSerializeHandle.mediate({
                            context: context,
                            handle: { quadStream: quadStream, context: context },
                            handleMediaType: this.mimeType
                        })).handle.data);
                    } else {
                        // Create framed JSON-LD output
                        const frame = {
                            "@id": id
                        };
                        const framedObjects: Map<Frame, JsonLdDocument> = (await this.mediators.mediatorRdfFrame.mediate({
                            context: context,
                            data: quadStream,
                            frames: [frame],
                            jsonLdContext: this.jsonLdContext
                        })).data;
                        outputString = JSON.stringify(framedObjects.get(frame));
                    }
                    this.push(`${outputString}\n`);
                }
            } catch (error) {
                this.logger.error(`Failed to process member ${id}
${inspect(error)}`);
            }
        }
    }

    protected async stringToQuadStream(data: string, baseIRI: string, mediaType: string): Promise<RDF.Stream> {
        const context = new ActionContext({});
        return (await this.mediators.mediatorRdfParseHandle.mediate({
            context: context,
            handle: {
                data: streamifyString(data),
                metadata: { baseIRI: baseIRI },
                context: context
            }, handleMediaType: mediaType
        })).handle.data
    }

    protected async stringToQuadArray(data: string, baseIRI: string, mediaType: string): Promise<RDF.Quad[]> {
        const context = new ActionContext({});
        return new Promise(async (resolve, reject) => {
            let quadArray: RDF.Quad[] = [];
            const stream = (await this.mediators.mediatorRdfParseHandle.mediate({
                context: context,
                handle: {
                    context: context,
                    data: streamifyString(data),
                    metadata: { baseIRI: baseIRI }
                }, handleMediaType: mediaType
            })).handle.data;
            stream.on('data', (quad: any) => {
                quadArray.push(quad);
            });
            stream.on('end', () => {
                resolve(quadArray);
            });
        });
    }

    protected async quadArrayToQuadStream(data: RDF.Quad[]): Promise<RDF.Stream> {
        return new Promise(async (resolve, reject) => {
            resolve(f.quadArrayToQuadStream(data.slice()));
        });
    }

    // Returns array of memberURI (string) -> immutable (boolean)
    protected getMemberUris(treeMetadata: any): string[] {
        let members: string[] = [];
        // Retrieve members from all collections found in the fragment
        const collections = treeMetadata.metadata.treeMetadata.collections;
        for (const [c, collectionValue] of collections.entries()) {
            for (let m in collectionValue.member) {
                const member = collectionValue.member[m]["@id"];
                members.push(member);
            }
        }
        return members;
    }

    protected extractEventTime(quads: RDF.Quad[]): Date | undefined {
        for (const quad of quads) {
            if (quad.subject.termType === 'NamedNode') {
                const predicate = quad.predicate.value;
                if (predicate === "http://www.w3.org/ns/prov#generatedAtTime") {
                    // Todo: make predicate configurable OR read from stream metadata
                    return new Date(quad.object.value);
                }
            }
        }

        return undefined;
    }
}

interface PageMetadata {
    request: CachePolicy.Request;
    response: CachePolicy.Response;
    url: string;
    data: string;
    statusCode: number;
    contentType: string;
}

export interface State {
    bookkeeper: SerializedBookkeper;
    memberBuffer: string;
    processedURIs: string;
}
