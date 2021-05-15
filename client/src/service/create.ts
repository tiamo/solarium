import {Keypair, PublicKey} from '@solana/web3.js';
import {didToPublicKey, isKeypair, pubkeyOf} from "../lib/util";
import {SolariumTransaction} from "../lib/solana/transaction";
import {get as getDID} from "../lib/did/get";
import {create as createDID} from "../lib/did/create";
import {DIDDocument} from "did-resolver";
import {Inbox} from "../lib/Inbox";
import {get} from "./get";
import {defaultSignCallback, SignCallback} from "../lib/wallet";
import {SolanaUtil} from "../lib/solana/solanaUtil";

/**
 * If a DID was already registered for this owner, return its document. Else create one
 * @param owner
 * @param payer
 * @param signCallback
 */
const getOrCreateDID = async (owner: PublicKey, payer: Keypair | PublicKey, signCallback: SignCallback): Promise<DIDDocument> => {
  try {
    console.log(`Looking for a DID owned by ${owner.toBase58()}`);
    return await getDID(owner);
  } catch (error) {
    if (error.message.startsWith('No DID found')) {
      console.log("No DID found - creating...");
      
      return createDID(owner, pubkeyOf(payer), signCallback)
    }
    throw error;
  }
} 

/**
 * Creates an inbox
 * @param owner
 * @param payer
 * @param signCallback
 */
export const create = async (owner: PublicKey, payer: Keypair | PublicKey, signCallback?: SignCallback): Promise<Inbox> => {
  const createSignedTx = signCallback || (isKeypair(payer) && defaultSignCallback(payer));
  if (!createSignedTx) throw new Error("No payer or sign callback specified")
  
  const didForOwner = await getOrCreateDID(owner, payer, createSignedTx)
  const didKey = didToPublicKey(didForOwner.id)

  console.log(`Creating inbox for DID: ${didForOwner.id}`);

  const inboxAddress = await SolariumTransaction.createInbox(pubkeyOf(payer), didKey, createSignedTx);
  
  const connection = SolanaUtil.getConnection();
  const inbox = await get(inboxAddress, connection);
  
  if (!inbox) {
    throw new Error('Error retrieving created inbox');
  }
  
  return inbox;
};
