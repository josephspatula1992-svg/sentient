//! NEP-171 (core, enumeration) and NEP-177 (metadata) so wallets and marketplaces see agents as ordinary NFTs.
//! Not implemented: approvals (NEP-178) and `nft_transfer_call`. Both are deliberate, see `nft_transfer`.

use super::*;
use near_sdk::assert_one_yocto;

#[near(serializers = [json])]
#[derive(Clone)]
pub struct TokenMetadata {
    pub title: String,
    pub description: String,
    pub media: String,
    pub copies: u64,
    /// JSON text of the agent's traits and record, so a marketplace can filter on them.
    pub extra: String,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Token {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
}

#[near(serializers = [json])]
pub struct ContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
}

impl Sentient {
    pub(crate) fn nft_log(&self, event: &str, data: near_sdk::serde_json::Value) {
        log!("EVENT_JSON:{}", json!({ "standard": "nep171", "version": "1.2.0", "event": event, "data": data }));
    }

    pub(crate) fn token_of(&self, a: &Agent) -> Token {
        let at = now();
        let (_, dormant, _) = self.effective(a, at);
        let g = a.genome;
        let extra = json!({
            "generation": a.generation,
            "dormant": dormant,
            "diligence": g.diligence, "boldness": g.boldness, "thrift": g.thrift,
            "sociability": g.sociability, "cunning": g.cunning,
            "reputation": a.reputation, "rating": a.rating,
            "jobs_done": a.jobs_done, "duel_wins": a.duel_wins,
            "account": a.account,
        })
        .to_string();
        Token {
            token_id: a.id.to_string(),
            owner_id: a.owner.clone(),
            metadata: TokenMetadata {
                title: a.name.clone(),
                description: a.persona.clone(),
                media: art::data_uri(a.id, &g, dormant),
                copies: 1,
                extra,
            },
        }
    }

    fn token_agent(&self, token_id: &str) -> Option<Agent> {
        token_id.parse::<u64>().ok().and_then(|id| self.agents.get(&id).cloned())
    }
}

#[near]
impl Sentient {
    /// Transfers the NFT, and with it the agent's money and record. Refused while the agent holds a job claim or a duel,
    /// because the counterparty's collusion checks assume the owner does not change underneath them.
    ///
    /// The old keeper's power ends here: the agent's own key stops being honoured (a parent contract cannot rotate a
    /// sub-account's keys, so this contract stops listening instead), any operator is cleared, and any stud offer is
    /// withdrawn. The new owner can act directly, or name an operator account with `set_operator`.
    ///
    /// Approvals and `nft_transfer_call` are not provided: both would let a marketplace move an agent mid-duel.
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        assert_one_yocto();
        // the yocto the standard demands is real money that arrived: book it, so the books stay exact
        self.totals.received += 1;
        self.totals.treasury += 1;
        require!(approval_id.is_none(), "approvals are not supported");
        let _ = memo;
        let mut a = self.token_agent(&token_id).unwrap_or_else(|| env::panic_str("no such token"));
        let sender = env::predecessor_account_id();
        require!(a.owner == sender, "only the owner can transfer");
        require!(receiver_id != sender, "the receiver is already the owner");
        // An agent that owned itself would pass the owner check with its own function-call key, which skips the key binding and
        // the risk cap, and its owner-only powers (withdraw, rekey, sweep) would belong to an account nobody can sign for.
        require!(
            receiver_id != a.account && receiver_id != env::current_account_id(),
            "an agent cannot be transferred to its own account or to the contract"
        );
        require!(a.active_claims == 0 && a.active_duels == 0, "an agent in a job or a duel cannot be transferred");
        self.remove_token(&sender, a.id);
        self.add_token(&receiver_id, a.id);
        // The seller's key is deleted from the account, so it can neither sign nor pay gas for a failed call.
        if a.key_bound {
            let _ = self.shell_revoke(&a.account, &a.key);
        }
        a.owner = receiver_id.clone();
        a.key_bound = false;
        a.operator = None;
        a.stud_fee = None;
        let id = a.id;
        self.put(a);
        self.nft_log(
            "nft_transfer",
            json!([{ "old_owner_id": sender, "new_owner_id": receiver_id, "token_ids": [token_id] }]),
        );
        self.emit("transferred", id, 0, 0, &format!("to {receiver_id}"));
    }

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        self.token_agent(&token_id).map(|a| self.token_of(&a))
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.next_agent as u128 - 1)
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.owner_tokens.get(&account_id).map(|s| s.len() as u128).unwrap_or(0))
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let from = from_index.map(|f| f.0 as u64).unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from + 1..self.next_agent).take(limit as usize).filter_map(|id| self.agents.get(&id)).map(|a| self.token_of(a)).collect()
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let from = from_index.map(|f| f.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100) as usize;
        match self.owner_tokens.get(&account_id) {
            Some(set) => set.iter().skip(from).take(limit).filter_map(|id| self.agents.get(id)).map(|a| self.token_of(a)).collect(),
            None => vec![],
        }
    }

    pub fn nft_metadata(&self) -> ContractMetadata {
        ContractMetadata { spec: "nft-1.0.0".into(), name: "Sentient".into(), symbol: "SENT".into() }
    }
}
