import { VerificationMethod } from 'did-resolver/src/resolver';
import { DIDDocument } from 'did-resolver';
import { isPublicKey, makeKeypair, PrivateKey } from '../util';
import { randomBytes } from '@stablelib/random';
import {
  x25519xc20pKeyWrap,
  x25519xc20pKeyUnwrap,
  XC20P_IV_LENGTH,
  XC20P_TAG_LENGTH,
  xc20pDecrypter,
  xc20pEncrypter,
} from './xc20pEncryption';

import * as u8a from 'uint8arrays';

import { convertPublicKey, convertSecretKey } from 'ed2curve-esm';
import { PublicKey } from '@solana/web3.js';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToString,
  stringToBytes,
  base58ToBytes,
  bytesToBase58,
} from './utils';
import { EncryptedKey, UserPubKey } from '../UserDetails';
import {
  VM_TYPE_ED25519VERIFICATIONKEY2018,
  VM_TYPE_X25519KEYAGREEMENTKEY2019,
} from '../constants';
import { kidToBytes, UserPrivateKey } from './UserAccountCrypto';
import { RandomSource } from '@stablelib/random/source/index';

export type CEK = Uint8Array;

// const shortenKID = (kid: string): string => kid.substring(kid.indexOf('#') + 1);

// Create a CEK for a new channel
export const generateCEK = async (prng?: RandomSource): Promise<CEK> => {
  const cek = randomBytes(32, prng);
  return Promise.resolve(cek);
};

// given a key or reference to a key in a DID, return the key itself
const getVerificationMethod = (
  vmOrRef: VerificationMethod | string,
  document: DIDDocument
): VerificationMethod => {
  if (Object.prototype.hasOwnProperty.call(vmOrRef, 'id'))
    return vmOrRef as VerificationMethod;

  const foundKey = (document.verificationMethod || []).find(
    key => key.id === vmOrRef
  );

  if (!foundKey) throw new Error(`Missing key ${vmOrRef}`);
  return foundKey;
};

export const encryptCEKForUserKey = async (
  cek: CEK,
  userkey: UserPubKey
): Promise<EncryptedKey> => {
  const kwResult = await x25519xc20pKeyWrap(userkey)(cek);

  return new EncryptedKey(
    kidToBytes('UserKey'), // TODO: What should be use here? last digits of did identifier?
    kwResult.iv,
    kwResult.tag,
    kwResult.epPubKey,
    kwResult.encryptedKey);
};

// Given an unencrypted channel CEK, encrypt it for a DID Document
// export const encryptCEKForUserKey = async (
//   cek: CEK,
//   didDocument: DIDDocument
// ): Promise<EncryptedKey> => {
//   const encryptedCEKPromises = (didDocument.keyAgreement || []).map(
//     async (keyOrRef): Promise<EncryptedKey> => {
//       const verificationMethod = getVerificationMethod(keyOrRef, didDocument);
//       return encryptCEKForVerificationMethod(cek, verificationMethod);
//     }
//   );
//
//   // TODO @martin just to get it to compile
//   // @ts-ignore
//   return Promise.all(encryptedCEKPromises);
// };

// Create a new CEK and encrypt it for the DID
export const createEncryptedCEK = async (
  userkey: UserPubKey
): Promise<EncryptedKey> => {
  const cek = await generateCEK();
  return encryptCEKForUserKey(cek, userkey);
};

// Decrypt an encrypted CEK for the with the key that was used to encrypt it
export const decryptKeyWrap = async (
  encryptedKey: EncryptedKey,
  key: PrivateKey
): Promise<CEK | UserPrivateKey> => {
  // decode information from CEKData
  // iv (24), tag (16), epk PubKey (rest)
  // TODO @martin just hacked together to get things compiling - please check
  const { kiv: iv, keyTag: tag, ephemeralPubkey: epkPub } = encryptedKey;

  // normalise the key into an uint array
  const ed25519Key = makeKeypair(key).secretKey;

  // The key is used both for Ed25519 signing and x25519 ECDH encryption
  // the two different protocols use the same curve (Curve25519) but
  // different key formats. Specifically Ed25519 uses a 64 byte secret key
  // (which is the same format used by Solana), which is in fact a keypair
  // i.e. combination of the secret and public key, whereas x25519 uses a 32 byte
  // secret key. In order to use the same key for both, we convert here
  // from Ed25519 to x25519 format.
  const curve25519Key = convertSecretKey(ed25519Key);

  const cek = await x25519xc20pKeyUnwrap(curve25519Key)(
    encryptedKey.keyCiphertext,
    tag,
    iv,
    epkPub
  );
  if (cek === null) {
    throw Error('There was a problem decrypting the CEK');
  }

  return cek;
};

// Find the CEK encrypted with a particular key, and decrypt it
export const decryptCEKWithUserKey = async (
  encryptedCEK: EncryptedKey,
  userKey: PrivateKey
): Promise<CEK> => {
  return decryptKeyWrap(encryptedCEK, userKey);
};

// Encrypt a message with a CEK
export const encryptMessage = async (
  message: string,
  cek: CEK
): Promise<string> => {
  const encryptMessage = await xc20pEncrypter(cek)(stringToBytes(message));
  // iv (24), ciphertext (var), tag (16)
  const encodedEncMessage = bytesToBase64(
    u8a.concat([
      encryptMessage.iv,
      encryptMessage.ciphertext,
      encryptMessage.tag,
    ])
  );

  return encodedEncMessage;
};

// Decrypt a message with the CEK used to encrypt it
export const decryptMessage = async (
  encryptedMessage: string,
  cek: CEK
): Promise<string> => {
  const encMessage = base64ToBytes(encryptedMessage);
  // iv (24), ciphertext (var), tag (16)
  const iv = encMessage.subarray(0, XC20P_IV_LENGTH);
  const ciphertext = encMessage.subarray(XC20P_IV_LENGTH, -XC20P_TAG_LENGTH);
  const tag = encMessage.subarray(-XC20P_TAG_LENGTH);

  const binMessage = await xc20pDecrypter(cek)(ciphertext, tag, iv);
  if (binMessage === null) {
    throw new Error('There was an error decoding the message!');
  }

  const message = bytesToString(binMessage);

  return message;
};

// TODO: Discuss about moving constantly into did:sol resolver code.
// Solarium uses the x25519 ECDH protocol for e2e encryption,
// which expects a key in the x25519 format (32-byte secret key)
// and type 'X25519KeyAgreementKey2019'.
// 'Sparse' DID documents on solana have an ed25519 key with the type
// 'Ed25519VerificationKey2018' by default, as this is the key type
// used to sign solana transactions. These keys are compatible with
// x25519, but require format conversion. So *unless a keyAgreement key exists*
// on the document, we artificially augment the document to include
// the converted key. This saves space on chain by avoiding the need
// to have the same key stored in two formats.
export const augmentDIDDocument = (didDocument: DIDDocument): DIDDocument => {
  // key agreement key already exists, so we can use it
  if (didDocument.keyAgreement && didDocument.keyAgreement.length)
    return didDocument;

  if (
    !didDocument.verificationMethod ||
    !didDocument.verificationMethod.length
  ) {
    throw Error(
      'Cannot augment DID document for x25519. The document has no keys'
    );
  }

  const keyAgreementKeys = didDocument.verificationMethod
    .filter(key => key.type === VM_TYPE_ED25519VERIFICATIONKEY2018) // only apply to Ed25519
    .filter(key => !!key.publicKeyBase58) // we currently only support keys in base58
    .map(key => ({
      ...key,
      id: key.id + '_keyAgreement',
      type: VM_TYPE_X25519KEYAGREEMENTKEY2019,
      publicKeyBase58: bytesToBase58(
        convertPublicKey(base58ToBytes(key.publicKeyBase58 as string))
      ),
    }));

  // add the new key to the document
  return {
    ...didDocument,
    publicKey: [...didDocument.verificationMethod, ...keyAgreementKeys],
    verificationMethod: [
      ...didDocument.verificationMethod,
      ...keyAgreementKeys,
    ],
    keyAgreement: keyAgreementKeys.map(key => key.id),
  };
};

// Given a private key, find the ID of the associated public key on the DID
// Note, this needs to operate on the augmented DIDDocument Version
export const findVerificationMethodForKey = (
  didDoc: DIDDocument,
  key: PrivateKey | PublicKey
): VerificationMethod | undefined => {
  const augmentedDIDDoc = augmentDIDDocument(didDoc);

  if (!isPublicKey(key)) {
    const keypair = makeKeypair(key);
    key = keypair.publicKey;
  }
  // operate on x25519 curve PubKey
  const pubkey = bytesToBase58(convertPublicKey(key.toBytes()));

  const foundVerificationMethod = (
    augmentedDIDDoc.verificationMethod || []
  ).find(verificationMethod => verificationMethod.publicKeyBase58 === pubkey);

  return foundVerificationMethod;
};
