import { ActorRdfFilterObject, IActionRdfFilterObject, IActorRdfFilterObjectOutput } from '@treecg/bus-rdf-filter-object';
import {Actor, IActorArgs, IActorTest, Mediator} from '@comunica/core';
import * as RDF from "rdf-js";
import {IActionRdfFrame, IActorRdfFrameOutput} from "../../bus-rdf-frame";
import * as f from "@dexagod/rdf-retrieval";

import {
  IActionRdfParseHandle,
  IActorOutputRdfParseHandle,
  IActorTestRdfParseHandle
} from "@comunica/bus-rdf-parse";

import { Store, Quad } from "n3"
import { storeStream } from 'rdf-store-stream';

/**
 * An RDF Filter Object actor that extracts quads related to a specific object using a quadstore.
 */
export class ActorRdfFilterObjectsWithQuadstore extends ActorRdfFilterObject {

  public constructor(args: IActorArgs<IActionRdfFilterObject, IActorTest, IActorRdfFilterObjectOutput>) {
    super(args);
  }

  public async test(action: IActionRdfFilterObject): Promise<IActorTest> {
    return true; // TODO implement
  }

  public async run(action: IActionRdfFilterObject): Promise<IActorRdfFilterObjectOutput> {
    const results = new Map<string, RDF.Stream>();
    const store: Store = (await storeStream(action.data)) as Store

    for (let id of action.objectURIs) {
      const quads = this.retrieveMember(store, id);
      const quadStream = await f.quadArrayToQuadStream(quads);
      results.set(id, quadStream)
    }

    return {
      data: results
    };
  }

  private retrieveMember(store: Store, id: string) {
    const ids : string[] = []
    function retrieveId(id: string) : Quad[] {
      if (ids.indexOf(id) !== -1) return [];
      ids.push(id)
      let quads : Quad[] = store.getQuads(id, null, null, null) || []
      for (let quad of quads) {
        quads = quads.concat(retrieveId(quad.object.id))
      }
      return quads
    }
    return retrieveId(id)
  }


}

export interface IActorRdfFilterObjectsWithQuadstoreArgs extends IActorArgs<IActionRdfFilterObject, IActorTest, IActorRdfFilterObjectOutput> {
}
