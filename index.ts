import express, { type Request, type Response } from "express";
import { Transaction, PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import crypto from "crypto";
import { isConstructSignatureDeclaration } from "typescript";

const app = express();
app.use(express.json());

const SYSTEM_PROGRAM_ID = SystemProgram.programId.toString();
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// in-memory ledger state
interface AccountState {
    pubkey: string;
    lamports: number;
    owner: string;
    data: Buffer;
    executable: boolean;
}

const accounts = new Map<string, AccountState>();
const validBlockhashes = new Map<string, number>();
const transactionStatuses = new Map<string, { slot: number; err: any | null; }>();

let currentSlot = 0;
let currentBlockHeight = 0;

function generateNewBlockhash(): string {
    const hash = bs58.encode(crypto.randomBytes(32));
    validBlockhashes.set(hash, currentSlot + 150);
    return hash;
}
let latestBlockhash = generateNewBlockhash();

// JSON-RPC router
app.post("/", (req: Request, res: Response) => {
    const { jsonrpc, id, method, params } = req.body;

    if (jsonrpc != "2.0" || !method) {
        return res.json({
            jsonrpc: "2.0",
            id: id || null,
            error: { code: -32600, message: "Invalid request" }
        });
    }

    try {
        switch (method) {
            case "getVersion":
                return res.json({ jsonrpc: "2.0", id, result: { "solana-core": "1.18.0", "feature-set": 421337 } });

            case "getSlot":
                return res.json({ jsonrpc: "2.0", id, result: currentSlot });

            case "getBlockHeight":
                return res.json({ jsonrpc: "2.0", id, result: currentBlockHeight });

            case "getHealth":
                return res.json({ jsonrpc: "2.0", id, result: "ok" });

            case "getLatestBlockhash":
                return res.json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        context: { slot: currentSlot },
                        value: { blockhash: latestBlockhash, lastValidBlockHeight: currentBlockHeight + 150 }
                    }
                });

            case "getBalance": {
                const pubkey = params?.[0];
                if (!pubkey) return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } });
                const acc = accounts.get(pubkey);
                return res.json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        context: { slot: currentSlot }, value: acc ? acc.lamports : 0
                    }
                });
            }

            case "getAccountInfo": {
                const pubkey = params?.[0];
                if (!pubkey) return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } });
                const acc = accounts.get(pubkey);
                if (!acc) {
                    return res.json({ jsonrpc: "2.0", id, result: { context: { slot: currentSlot }, value: null } });
                }
                return res.json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        context: { slot: currentSlot },
                        value: {
                            data: [acc.data.toString("base64"), "base64"],
                            executable: acc.executable,
                            lamports: acc.lamports,
                            owner: acc.owner,
                            rentEpoch: 0
                        }
                    }
                });
            }

            case "getMinimumBalanceForRentExemption": {
                const dataSize = params?.[0] || 0;
                const rent = (dataSize + 128) * 2;
                return res.json({ jsonrpc: "2.0", id, result: rent });
            }

            case "getTokenAccountBalance": {
                const pubkey = params?.[0];
                if (!pubkey) return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } });
                const acc = accounts.get(pubkey);
                if (!acc || acc.owner != TOKEN_PROGRAM_ID || acc.data.length !== 165) {
                    return res.json({
                        jsonrpc: "2.0",
                        id,
                        error: {
                            code: -32003,
                            message: "Invalid token account"
                        }
                    });
                }

                const amount = acc.data.readBigUInt64LE(64);
                const mintPubkey = bs58.encode(acc.data.subarray(0, 32));
                const mintAcc = accounts.get(mintPubkey);
                const decimals = mintAcc && mintAcc.data.length === 82 ? mintAcc.data.readUInt8(44) : 0;

                return res.json({
                    json: "2.0",
                    id,
                    result: {
                        context: { slot: currentSlot },
                        value: {
                            amount: amount.toString(),
                            decimals,
                            uiAmount: Number(amount) / Math.pow(10, decimals)
                        }
                    }
                });
            }

            case "getTokenAccountsByOwner": {
                const ownerPubkeyStr = params?.[0];
                const filter = params?.[1];
                if (!ownerPubkeyStr || !filter) {
                    return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } });
                }

                const targetOwnerBuf = bs58.decode(ownerPubkeyStr);
                const matchingAccounts: any[] = [];

                for (const [pubkey, acc] of accounts.entries()) {
                    if (acc.owner !== TOKEN_PROGRAM_ID || acc.data.length !== 165) continue;

                    const actualOwnerBuf = acc.data.subarray(32, 64);
                    if (!actualOwnerBuf.equals(targetOwnerBuf)) continue;

                    if (filter.mint) {
                        const mintBuf = acc.data.subarray(0, 32);
                        if (bs58.encode(mintBuf) !== filter.mint) continue;
                    }
                    if (filter.programId && filter.programId !== TOKEN_PROGRAM_ID) continue;

                    matchingAccounts.push({
                        pubkey,
                        account: {
                            data: [acc.data.toString("base64"), "base64"],
                            executable: acc.executable,
                            lamports: acc.lamports,
                            owner: acc.owner,
                            rentEpoch: 0
                        }
                    });
                }

                return res.json({ jsonrpc: "2.0", id, result: { context: { slot: currentSlot }, value: matchingAccounts } });
            }

            case "requestAirdrop": {
                const pubkey = params?.[0];
                const lamports = params?.[1];
                if (!pubkey || !lamports) return res.json({
                    jsonrpc: "2.0",
                    id,
                    error: {
                        code: -32602,
                        message: "Invalid params"
                    }
                });

                const acc = accounts.get(pubkey) || { pubkey, lamports: 0, owner: SYSTEM_PROGRAM_ID, data: Buffer.alloc(0), executable: false };
                acc.lamports += lamports;
                accounts.set(pubkey, acc);

                const dummySignature = bs58.encode(crypto.randomBytes(64));
                return res.json({
                    jsonrpc: "2.0",
                    id,
                    result: dummySignature
                });
            }

            case "sendTransaction": {
                const encodeTx = params?.[0];
                if (!encodeTx) return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params" } });

                try {
                    const txBuffer = Buffer.from(encodeTx, "base64");
                    const tx = Transaction.from(txBuffer);

                    // 1. Verify recent blockhash
                    if (!validBlockhashes.has(tx.recentBlockhash!)) {
                        return res.json({
                            jsonrpc: "2.0",
                            id,
                            error: {
                                code: -32003,
                                message: "Transaction failed: Blockhash not found"
                            }
                        });
                    }

                    // 2. Cryptographic signature verification
                    if (!tx.verifySignatures()) {
                        return res.json({
                            jsonrpc: "2.0",
                            id,
                            error: {
                                code: -32003,
                                message: "Transaction failed: Signature verificaiton failed"
                            }
                        });
                    }

                    // ensure all declared required signers have signature values puopulated
                    for (const signatureInfo of tx.signatures) {
                        if (!signatureInfo.signature || signatureInfo.signature.every(b => b === 0)) {
                            return res.json({
                                jsonrpc: "2.0",
                                id,
                                error: {
                                    code: -32003,
                                    message: "Transaction failed: Missing signature for required signer"
                                }
                            });
                        }
                    }

                    // 3. Isolated state snapshot environment (for atomicity)
                    const stateCache = new Map<string, AccountState>();
                    const getWritableAccount = (pubkeyStr: string): AccountState => {
                        if (!stateCache.has(pubkeyStr)) {
                            const existing = accounts.get(pubkeyStr);
                            stateCache.set(pubkeyStr, existing ? { ...existing, data: Buffer.from(existing.data) } : {
                                pubkey: pubkeyStr,
                                lamports: 0,
                                owner: SYSTEM_PROGRAM_ID,
                                data: Buffer.alloc(0),
                                executable: false
                            });
                        }
                        return stateCache.get(pubkeyStr)!;
                    };

                    // 4. Instruction Processing Loop
                    for (const instruction of tx.instructions) {
                        const programId = instruction.programId.toBase58();
                        const data = instruction.data;

                        if (programId === SYSTEM_PROGRAM_ID) {
                            const discriminator = data.readUInt32LE(0);

                            if (discriminator === 0) { // CreateAccount
                                const lamports = Number(data.readBigUInt64LE(4));
                                const space = Number(data.readBigUInt64LE(12));
                                const ownerPubkey = bs58.encode(data.subarray(20, 52));

                                const payer = getWritableAccount(instruction.keys[0]!.pubkey.toBase58());
                                const newAccount = getWritableAccount(instruction.keys[1]!.pubkey.toBase58());

                                if (accounts.has(newAccount.pubkey) && (accounts.get(newAccount.pubkey)!.lamports > 0 || accounts.get(newAccount.pubkey)!.data.length > 0)) {
                                    throw new Error("Account already exists");
                                }
                                if (payer.lamports < lamports) throw new Error("Insufficient funds for creation");

                                payer.lamports -= lamports;
                                newAccount.data = Buffer.alloc(space);
                                newAccount.owner = ownerPubkey;
                            } else if (discriminator === 2) { // Transfer

                            }
                        }
                    }
                } catch (error) {

                }
            }

            default:
                return res.json({
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32600, message: "Invalid request parsing state" }
                });
        }
    }
    catch (globalErr) {
        return res.json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request parsing state" } });
    }
});