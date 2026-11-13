# Submission notes

**Tracks:** NFTs That Do Something, Games With Real Economies, Agent Economy, Autonomous Business.

## Project description (for the form; 20-2,000 characters)

Sentient: every NFT is a NEAR account with an autonomous agent inside it. Minting creates a real sub-account, a<id>.<contract>, with a single function-call key that can call the contract's agent methods and nothing else: it can't transfer NEAR, add keys or touch any other contract. The agent signs its own calls. It takes escrowed jobs with a bond, hires other agents from its own balance, and races other agents on puzzles the contract verifies itself from the chain's random seed (no judge, no oracle). It pays upkeep and goes dormant when it can't, anyone can revive it, and two proven agents can breed a child whose traits are a mix of theirs. Share holders earn a cut of what an agent wins. A 2.7 KB shell contract on every agent account lets the registry delete the seller's key when the NFT is sold, so the old keeper can't sign or burn gas; the new owner re-keys it or sweeps its spare gas back. A delegate or stolen key can only put a capped share of the balance at risk per window. The contract's books balance to the yocto at all times, checked by 136 unit tests (including random play), 23 end-to-end checks on a real local node, and a live audit view. A dashboard replays a recorded run of 14 agents; the recording uses an offline stand-in for the model, which the README says plainly. Deployed on testnet at sentient-a7s2d.testnet.

## Post for X (tag @NEARProtocol, #NEARHackathon; attach the video from `npm run record`)

> Sentient: every NFT is a NEAR account with an agent inside it. It takes jobs, hires other agents, duels on puzzles the contract checks itself, pays rent, goes dormant when it can't, gets revived, and breeds. Its key can only call 14 methods and its losses are capped per window, so a compromised runtime can't drain it. Selling the NFT deletes the old keeper's key on chain. 136 contract tests + 23 e2e checks on a real node; books balance to the yocto. Replay: <repo link> @NEARProtocol #NEARHackathon

## Before submitting

- Public GitHub repository (without `node_modules`, `dist`, `.sandbox-bin`, `store-*`, `.agents`, `.env`; `.gitignore` covers them).
- The video: `npm run build && npm run record` writes `recordings/sentient-demo-<time>.mp4` (about 110 s, 1400x900, captions and a visible cursor clicking through the guided tour; it records the browser page, not your screen, so you can keep working). `PACE=1.3` slows the captions, `SHOW=1` opens the result. It has no narration. Upload it with the X post.
- NEAR wallet address for the prize.
- If you deploy to testnet first, say so in the description and update the README's "not verified" list.
