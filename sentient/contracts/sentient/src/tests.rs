use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, CurveType, PromiseResult};

const T0: u64 = 1_000_000;

fn a(n: &str) -> AccountId {
    format!("{n}.testnet").parse().unwrap()
}

fn pk(n: u8) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, vec![n; 32]).unwrap()
}

fn contract_id() -> AccountId {
    "sentient.testnet".parse().unwrap()
}

fn ctx_as(who: AccountId, deposit: u128, secs: u64, signer: Option<PublicKey>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(who.clone())
        .signer_account_id(who)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(secs * 1_000_000_000)
        .random_seed([(secs.wrapping_mul(31).wrapping_add(7) % 250) as u8 + 1; 32]);
    if let Some(k) = signer {
        b.signer_account_pk(k);
    }
    testing_env!(b.build());
}

fn ctx(who: &str, deposit: u128, secs: u64) {
    ctx_as(a(who), deposit, secs, None);
}

/// Money in these tests is chosen so every share is a round number. Upkeep is off unless a test turns it on.
fn cfg() -> Config {
    Config {
        chair: a("chair"),
        mint_min: NEAR,
        seed_gas: NEAR / 4,
        storage_fee: NEAR * 3 / 100,
        mint_fee_bps: 300,
        min_ledger: NEAR / 10,
        upkeep_per_sec: 0,
        revive_min: NEAR / 5,
        min_bounty: NEAR / 20,
        job_storage_fee: NEAR / 50,
        job_fee_bps: 200,
        bond_bps: 1_000,
        min_bond: NEAR / 100,
        min_work_secs: 10,
        max_work_secs: 86_400,
        review_secs: 600,
        arbiter_secs: 3_600,
        prune_secs: 86_400,
        max_claims: 2,
        min_stake: NEAR / 100,
        duel_storage_fee: NEAR / 250,
        duel_fee_bps: 500,
        duel_start_secs: 4,
        duel_window_secs: 120,
        challenge_ttl_secs: 600,
        max_duels: 2,
        dividend_bps: 1_500,
        curve_base: NEAR / 100,
        curve_slope: NEAR / 1_000,
        trade_fee_bps: 300,
        royalty_bps: 6_000,
        sell_lock_secs: 60,
        holding_storage_fee: NEAR / 500,
        max_shares_per_trade: 1_000,
        actor_risk_bps: 10_000,
        risk_window_secs: 3_600,
        breed_cost: NEAR,
        breed_cooldown_secs: 1_000,
    }
}

fn new_with(f: impl FnOnce(&mut Config)) -> Sentient {
    let mut c = cfg();
    f(&mut c);
    // `testing_env!` carries storage over from the previous environment, so a second contract in one test would read the
    // first one's leftovers. Start from nothing.
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(a("chair"))
        .signer_account_id(a("chair"))
        .block_timestamp(T0 * 1_000_000_000);
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        vec![],
        Default::default(),
        Default::default(),
        None,
    ));
    Sentient::new(c)
}

fn new_contract() -> Sentient {
    new_with(|_| {})
}

fn genome() -> Genome {
    Genome::from_array([60, 60, 60, 60, 60])
}

/// Mint an agent for `owner` (2 NEAR in). Its free balance is 2 - 0.06 - 0.25 - 0.03 = 1.66 NEAR.
fn mint(c: &mut Sentient, owner: &str, k: u8, secs: u64) -> u64 {
    ctx(owner, 2 * NEAR, secs);
    c.mint(format!("agent-{k}"), "a test persona".into(), Some(genome()), pk(k))
}

const MINTED_LEDGER: u128 = 2 * NEAR - 2 * NEAR * 300 / 10_000 - NEAR / 4 - NEAR * 3 / 100;
const BOUNTY_DEPOSIT: u128 = NEAR + NEAR / 50;

/// Every figure the contract keeps must agree with every other, and with the records they summarise.
fn books(c: &Sentient) {
    let t = &c.totals;
    assert!(
        t.balanced(),
        "unbalanced: received {} vs sent {} + ledgers {} + locked {} + escrow {} + reserves {} + dividends {} + treasury {} + credits {}",
        t.received, t.sent, t.ledgers, t.locked, t.escrow, t.reserves, t.dividends, t.treasury, t.credits
    );
    let (mut l, mut k, mut r, mut d) = (0u128, 0u128, 0u128, 0u128);
    for id in 1..c.next_agent {
        let ag = c.agents.get(&id).expect("agent");
        l += ag.ledger;
        k += ag.locked;
        r += ag.reserve;
        d += ag.div_pool;
        assert_eq!(ag.reserve, econ::integral(c.cfg.curve_base, c.cfg.curve_slope, ag.shares as u128), "reserve of #{id}");
        let mut held = 0u64;
        for who in ["alice", "bob", "carol", "dave", "fan", "early", "mid", "late"] {
            if let Some(h) = c.holdings.get(&market::holding_key(id, &a(who))) {
                assert!(h.snap <= ag.div_acc, "holder {who} of #{id} is ahead of the agent's dividend accumulator");
                held += h.shares;
            }
        }
        assert_eq!(held, ag.shares, "holdings of #{id} add up to its supply");
    }
    assert_eq!(l, t.ledgers, "sum of agent ledgers");
    assert_eq!(k, t.locked, "sum of agent locks");
    assert_eq!(r, t.reserves, "sum of reserves");
    assert_eq!(d, t.dividends, "sum of dividend pools");
    let escrow: u128 = (1..c.next_job).filter_map(|i| c.jobs.get(&i)).filter(|j| !j.status.is_final()).map(|j| j.bounty).sum();
    assert_eq!(escrow, t.escrow, "escrow against open jobs");
    let mut held: u128 = (1..c.next_job)
        .filter_map(|i| c.jobs.get(&i))
        .filter(|j| matches!(j.status, JobStatus::Claimed | JobStatus::Submitted | JobStatus::Disputed))
        .map(|j| j.bond)
        .sum();
    for i in 1..c.next_duel {
        if let Some(d) = c.duels.get(&i) {
            held += match d.status {
                DuelStatus::Open => d.stake,
                DuelStatus::Live => 2 * d.stake,
                _ => 0,
            };
        }
    }
    assert_eq!(held, t.locked, "locked money against bonds and stakes");
}

fn post(c: &mut Sentient, who: &str, secs: u64) -> u64 {
    ctx(who, BOUNTY_DEPOSIT, secs);
    c.post_job("Summarise the paper".into(), "file://brief".into(), "sha256:brief".into(), None, None, 300, None)
}

fn claim_submit(c: &mut Sentient, owner: &str, agent: u64, job: u64, secs: u64) {
    ctx(owner, 0, secs);
    c.claim_job(agent, job);
    ctx(owner, 0, secs + 5);
    c.submit_work(agent, job, "sha256:work".into(), "file://work".into());
}

fn solve_duel(c: &Sentient, id: u64) -> u64 {
    let d = c.duel(id);
    puzzle::solve(d.kind.unwrap(), &d.params).unwrap()
}

// ───────────────────────────── minting and the NFT ─────────────────────────────

#[test]
fn mint_creates_the_agent_its_account_and_balanced_books() {
    let mut c = new_contract();
    let id = mint(&mut c, "alice", 1, T0);
    assert_eq!(id, 1);
    let ag = c.agent(1);
    assert_eq!(ag.account, "a1.sentient.testnet".parse::<AccountId>().unwrap());
    assert_eq!(ag.owner, a("alice"));
    assert_eq!(ag.ledger, MINTED_LEDGER);
    assert_eq!(c.totals.treasury, 2 * NEAR * 300 / 10_000 + NEAR * 3 / 100);
    assert_eq!(c.totals.sent, NEAR / 4, "the seed for the agent's own account");
    assert!(ag.key_bound && !ag.dormant && ag.generation == 0 && ag.rating == 1000);
    assert_eq!(c.by_account.get(&ag.account), Some(&1));
    books(&c);
}

#[test]
#[should_panic(expected = "at least")]
fn mint_needs_the_minimum() {
    let mut c = new_contract();
    ctx("alice", NEAR / 2, T0);
    c.mint("x".into(), "".into(), Some(genome()), pk(1));
}

#[test]
#[should_panic(expected = "traits may sum to at most 300")]
fn mint_refuses_a_genome_over_budget() {
    let mut c = new_contract();
    ctx("alice", 2 * NEAR, T0);
    c.mint("x".into(), "".into(), Some(Genome::from_array([100, 100, 100, 100, 0])), pk(1));
}

#[test]
#[should_panic(expected = "needs a name")]
fn mint_needs_a_name() {
    let mut c = new_contract();
    ctx("alice", 2 * NEAR, T0);
    c.mint("  ".into(), "".into(), Some(genome()), pk(1));
}

#[test]
fn mint_without_a_genome_draws_a_valid_one() {
    let mut c = new_contract();
    for i in 0..20u8 {
        ctx("alice", 2 * NEAR, T0 + i as u64);
        let id = c.mint(format!("r{i}"), "".into(), None, pk(i + 1));
        let g = c.agent(id).genome;
        assert!(g.check().is_ok() && g.total() >= 230, "{g:?}");
    }
    books(&c);
}

#[test]
fn nft_views_show_the_agent_as_a_token() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    mint(&mut c, "alice", 2, T0);
    mint(&mut c, "bob", 3, T0);
    assert_eq!(c.nft_total_supply().0, 3);
    assert_eq!(c.nft_supply_for_owner(a("alice")).0, 2);
    let t = c.nft_token("2".into()).unwrap();
    assert_eq!(t.owner_id, a("alice"));
    assert_eq!(t.metadata.title, "agent-2");
    assert!(t.metadata.media.starts_with("data:image/svg+xml;utf8,<svg"));
    assert!(t.metadata.extra.contains("\"generation\":0"));
    assert_eq!(c.nft_tokens_for_owner(a("alice"), None, None).len(), 2);
    assert_eq!(c.nft_tokens(None, Some(2)).len(), 2);
    assert!(c.nft_token("99".into()).is_none());
}

// ───────────────────────────── the shell on each agent's account ─────────────────────────────

fn receipts_to(account: &AccountId) -> Vec<near_sdk::mock::Receipt> {
    near_sdk::test_utils::get_created_receipts().into_iter().filter(|r| r.receiver_id == *account).collect()
}

fn calls(rs: &[near_sdk::mock::Receipt]) -> Vec<(String, Vec<u8>)> {
    rs.iter()
        .flat_map(|r| r.actions.iter())
        .filter_map(|x| match x {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } => {
                Some((String::from_utf8(method_name.clone()).unwrap(), args.clone()))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn the_shell_is_tiny_and_is_what_gets_deployed_on_every_new_account() {
    assert!(SHELL_WASM.starts_with(b"\0asm") && SHELL_WASM.len() < 4_096, "{} bytes", SHELL_WASM.len());
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let account = c.agent(1).account;
    let rs = receipts_to(&account);
    let actions: Vec<_> = rs.iter().flat_map(|r| r.actions.iter()).collect();
    assert!(actions.iter().any(|x| matches!(x, near_sdk::mock::MockAction::DeployContract { code, .. } if code == SHELL_WASM)));
    assert!(actions.iter().any(|x| matches!(x, near_sdk::mock::MockAction::AddKeyWithFunctionCall { receiver_id, .. } if *receiver_id == contract_id())));
}

#[test]
fn a_sale_deletes_the_sellers_key_from_the_account() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let ag = c.agent(1);
    ctx("alice", 1, T0);
    c.nft_transfer(a("bob"), "1".into(), None, None);
    let cs = calls(&receipts_to(&ag.account));
    assert_eq!(cs.len(), 1);
    assert_eq!(cs[0].0, "revoke");
    assert_eq!(cs[0].1, ag.key.as_bytes(), "the host wants a curve byte then the key, with no length prefix");
    assert_eq!(cs[0].1.len(), 33);
    assert!(!c.agent(1).key_bound);
    // a second sale has nothing left to revoke
    ctx("bob", 1, T0 + 1);
    c.nft_transfer(a("carol"), "1".into(), None, None);
    assert!(calls(&receipts_to(&ag.account)).is_empty());
}

#[test]
fn a_new_owner_gives_the_agent_a_new_key_through_the_shell() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let old = c.agent(1).key;
    // while the old key is still honoured, replacing it revokes it first
    ctx("alice", 0, T0);
    c.set_runtime_key(1, pk(7));
    let cs = calls(&receipts_to(&c.agent(1).account));
    assert_eq!(cs.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["revoke", "grant"]);
    assert_eq!(cs[0].1, old.as_bytes());
    let g = &cs[1].1;
    let klen = g[0] as usize;
    assert_eq!(klen, 33);
    assert_eq!(&g[1..1 + klen], pk(7).as_bytes());
    let rlen = g[1 + klen] as usize;
    assert_eq!(&g[2 + klen..2 + klen + rlen], contract_id().as_str().as_bytes());
    assert_eq!(&g[2 + klen + rlen..], AGENT_METHODS.as_bytes());
    assert!(c.agent(1).key_bound && c.agent(1).key == pk(7));
    // after a sale the old key is already gone, so only a grant is needed
    ctx("alice", 1, T0 + 1);
    c.nft_transfer(a("bob"), "1".into(), None, None);
    ctx("bob", 0, T0 + 2);
    c.set_runtime_key(1, pk(8));
    let cs = calls(&receipts_to(&c.agent(1).account));
    assert_eq!(cs.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["grant"]);
    // and the new key is the one the contract now listens to
    let ag = c.agent(1);
    ctx_as(ag.account.clone(), 0, T0 + 3, Some(pk(8)));
    c.authorize(&ag);
}

#[test]
#[should_panic(expected = "only the agent's owner")]
fn only_the_owner_can_rekey() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.set_operator(1, Some(a("keeper")));
    ctx("keeper", 0, T0);
    c.set_runtime_key(1, pk(7));
}

#[test]
fn the_owner_can_take_the_gas_tank_back() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.sweep_tank(1, U128(NEAR / 20));
    let cs = calls(&receipts_to(&c.agent(1).account));
    assert_eq!(cs.len(), 1);
    assert_eq!(cs[0].0, "sweep");
    assert_eq!(&cs[0].1[..16], &(NEAR / 20).to_le_bytes());
    assert_eq!(&cs[0].1[16..], a("alice").as_str().as_bytes());
}

#[test]
#[should_panic(expected = "only the agent's owner")]
fn only_the_owner_sweeps() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let account = c.agent(1).account;
    ctx_as(account, 0, T0, Some(pk(1)));
    c.sweep_tank(1, U128(0));
}

#[test]
fn repeat_meeting_records_are_freed_once_their_window_is_over_and_not_before() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 100), None, Some(puzzle::DIGITS));
    ctx("bob", 0, T0 + 11);
    c.accept_duel(d, y);
    let right = solve_duel(&c, d);
    ctx("alice", 0, T0 + 20);
    assert!(c.answer_duel(d, x, right));
    let key = format!("d:{x}:{y}");
    assert!(c.get_pair(key.clone()).is_some());
    ctx("anyone", 0, T0 + 20 + DUEL_PAIR_WINDOW);
    assert_eq!(c.prune_pairs(vec![key.clone(), "nonsense".into(), "d:9:9".into()]), 0, "still inside its window");
    ctx("anyone", 0, T0 + 20 + DUEL_PAIR_WINDOW + 1);
    assert_eq!(c.prune_pairs(vec![key.clone()]), 1);
    assert!(c.get_pair(key).is_none());
    books(&c);
}

// ───────────────────────────── what a delegate or a stolen key can lose ─────────────────────────────

fn tight() -> Sentient {
    new_with(|c| {
        c.actor_risk_bps = 3_000; // 30% of 1.66 NEAR = 0.498
        c.risk_window_secs = 600;
    })
}

#[test]
#[should_panic(expected = "more of the agent's balance at risk")]
fn an_operator_cannot_put_more_than_the_cap_at_risk_at_once() {
    let mut c = tight();
    let x = mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.set_operator(x, Some(a("keeper")));
    ctx("keeper", 0, T0 + 1);
    c.challenge(x, U128(NEAR * 3 / 10), None, None);
    ctx("keeper", 0, T0 + 2);
    c.challenge(x, U128(NEAR * 3 / 10), None, None); // 0.6 held > 0.498
}

#[test]
#[should_panic(expected = "more of the agent's balance at risk")]
fn a_stolen_key_is_capped_too() {
    let mut c = tight();
    let x = mint(&mut c, "alice", 1, T0);
    let account = c.agent(x).account;
    ctx_as(account, 0, T0 + 1, Some(pk(1)));
    c.challenge(x, U128(NEAR * 6 / 10), None, None);
}

#[test]
fn the_owner_is_not_limited() {
    let mut c = tight();
    let x = mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0 + 1);
    c.challenge(x, U128(NEAR), None, None);
    books(&c);
}

/// The operator of alice's agent stakes 0.4 NEAR (within the 0.498 cap) and loses it to bob's agent.
fn operator_loses_forty_percent(c: &mut Sentient) -> u64 {
    let x = mint(c, "alice", 1, T0);
    let y = mint(c, "bob", 2, T0);
    ctx("alice", 0, T0);
    c.set_operator(x, Some(a("keeper")));
    ctx("keeper", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR * 4 / 10), None, Some(puzzle::DIGITS));
    ctx("bob", 0, T0 + 20);
    c.accept_duel(d, y);
    let right = solve_duel(c, d);
    ctx("bob", 0, T0 + 30);
    assert!(c.answer_duel(d, y, right));
    assert_eq!(c.agent(x).win_lost, NEAR * 4 / 10);
    x
}

#[test]
#[should_panic(expected = "more of the agent's balance at risk")]
fn losses_count_against_the_window() {
    let mut c = tight();
    let x = operator_loses_forty_percent(&mut c);
    // 0.4 is already gone this window, so even 0.2 more would pass the 0.498 cap
    ctx("keeper", 0, T0 + 40);
    c.challenge(x, U128(NEAR * 2 / 10), None, None);
}

#[test]
fn a_new_window_starts_fresh_from_what_is_left() {
    let mut c = tight();
    let x = operator_loses_forty_percent(&mut c);
    ctx("keeper", 0, T0 + 700);
    let id = c.challenge(x, U128(NEAR * 3 / 10), None, None);
    assert_eq!(c.duel(id).stake, NEAR * 3 / 10);
    let ag = c.agent(x);
    assert_eq!(ag.win_lost, 0);
    assert_eq!(ag.win_base, ag.ledger + ag.locked + c.cfg.duel_storage_fee, "the base is the balance when the window began, before this challenge's fee");
    books(&c);
}

#[test]
#[should_panic(expected = "more of the agent's balance at risk")]
fn bounties_an_operator_posts_count_as_money_spent() {
    let mut c = tight();
    let x = mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.set_operator(x, Some(a("keeper")));
    ctx("keeper", 0, T0 + 1);
    c.post_job("a".into(), "".into(), "h".into(), Some(U128(NEAR * 3 / 10)), None, 300, Some(x));
    ctx("keeper", 0, T0 + 2);
    c.post_job("b".into(), "".into(), "h".into(), Some(U128(NEAR * 3 / 10)), None, 300, Some(x));
}

#[test]
#[should_panic(expected = "more of the agent's balance at risk")]
fn the_owner_can_tighten_an_agents_cap() {
    let mut c = tight();
    let x = mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.set_risk_bps(x, 500); // 5% of 1.66 = 0.083
    assert_eq!(c.agent(x).risk_bps, 500);
    ctx("alice", 0, T0 + 1);
    c.set_operator(x, Some(a("keeper")));
    ctx("keeper", 0, T0 + 2);
    c.challenge(x, U128(NEAR / 10), None, None);
}

#[test]
#[should_panic(expected = "only the agent's owner")]
fn nobody_else_can_loosen_the_cap() {
    let mut c = tight();
    let x = mint(&mut c, "alice", 1, T0);
    ctx("mallory", 0, T0);
    c.set_risk_bps(x, 10_000);
}

// ───────────────────────────── who may act ─────────────────────────────

#[test]
fn owner_operator_and_the_agents_own_key_may_act_but_nobody_else() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let ag = c.agent(1);
    ctx("alice", 0, T0);
    c.authorize(&ag);
    ctx("alice", 0, T0);
    c.set_operator(1, Some(a("keeper")));
    let ag = c.agent(1);
    ctx("keeper", 0, T0);
    c.authorize(&ag);
    ctx_as(ag.account.clone(), 0, T0, Some(pk(1)));
    c.authorize(&ag);
}

#[test]
#[should_panic(expected = "not authorised")]
fn a_stranger_cannot_act_for_an_agent() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let ag = c.agent(1);
    ctx("mallory", 0, T0);
    c.authorize(&ag);
}

#[test]
#[should_panic(expected = "not authorised")]
fn the_agents_account_with_a_different_key_is_refused() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let ag = c.agent(1);
    ctx_as(ag.account.clone(), 0, T0, Some(pk(99)));
    c.authorize(&ag);
}

#[test]
fn a_transfer_ends_the_old_keepers_power_and_hands_over_the_money() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.set_operator(1, Some(a("keeper")));
    ctx("alice", 0, T0);
    c.set_stud_fee(1, Some(U128(NEAR / 10)));
    ctx("alice", 1, T0);
    c.nft_transfer(a("bob"), "1".into(), None, None);
    let ag = c.agent(1);
    assert_eq!(ag.owner, a("bob"));
    assert!(!ag.key_bound && ag.operator.is_none() && ag.stud_fee.is_none());
    assert_eq!(ag.ledger, MINTED_LEDGER, "the money goes with the agent");
    assert_eq!(c.nft_supply_for_owner(a("alice")).0, 0);
    assert_eq!(c.nft_supply_for_owner(a("bob")).0, 1);
    ctx("bob", 0, T0);
    c.authorize(&ag);
    books(&c);
}

#[test]
#[should_panic(expected = "not authorised")]
fn after_a_transfer_the_old_key_no_longer_works() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 1, T0);
    c.nft_transfer(a("bob"), "1".into(), None, None);
    let ag = c.agent(1);
    ctx_as(ag.account.clone(), 0, T0, Some(pk(1)));
    c.authorize(&ag);
}

#[test]
#[should_panic(expected = "cannot be transferred")]
fn an_agent_in_a_duel_cannot_be_transferred() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.challenge(1, U128(NEAR / 10), None, None);
    ctx("alice", 1, T0);
    c.nft_transfer(a("bob"), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "cannot be transferred to its own account")]
fn an_agent_cannot_be_given_to_itself() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let own = c.agent(1).account;
    ctx("alice", 1, T0);
    c.nft_transfer(own, "1".into(), None, None);
}

#[test]
#[should_panic(expected = "cannot be transferred to its own account or to the contract")]
fn an_agent_cannot_be_given_to_the_contract() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 1, T0);
    c.nft_transfer(contract_id(), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_transfers() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("mallory", 1, T0);
    c.nft_transfer(a("mallory"), "1".into(), None, None);
}

// ───────────────────────────── cost of living ─────────────────────────────

#[test]
fn upkeep_is_charged_lazily_and_goes_to_the_treasury() {
    let mut c = new_with(|c| c.upkeep_per_sec = NEAR / 10_000);
    mint(&mut c, "alice", 1, T0);
    let treasury0 = c.totals.treasury;
    ctx("anyone", 0, T0 + 1_000);
    c.poke(1);
    let ag = c.agent(1);
    assert_eq!(ag.upkeep_paid, NEAR / 10);
    assert_eq!(ag.ledger, MINTED_LEDGER - NEAR / 10);
    assert_eq!(c.totals.treasury, treasury0 + NEAR / 10);
    books(&c);
}

#[test]
fn an_agent_that_cannot_pay_goes_dormant_and_views_show_it_before_anyone_pokes() {
    let mut c = new_with(|c| c.upkeep_per_sec = NEAR / 1_000);
    mint(&mut c, "alice", 1, T0);
    ctx("anyone", 0, T0 + 1_000);
    let v = c.get_agent(1).unwrap();
    assert!(!v.agent.dormant, "nothing has touched it yet");
    assert_eq!(v.live_ledger, MINTED_LEDGER - NEAR);
    assert!(!v.live_dormant);
    ctx("anyone", 0, T0 + 2_000);
    let v = c.get_agent(1).unwrap();
    assert!(v.live_dormant && v.live_ledger == 0 && v.runway_secs == 0);
    c.poke(1);
    let ag = c.agent(1);
    assert!(ag.dormant && ag.ledger == 0);
    assert_eq!(ag.upkeep_paid, MINTED_LEDGER);
    books(&c);
}

#[test]
#[should_panic(expected = "dormant")]
fn a_dormant_agent_cannot_act() {
    let mut c = new_with(|c| c.upkeep_per_sec = NEAR / 1_000);
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0 + 5_000);
    c.challenge(1, U128(NEAR / 100), None, None);
}

#[test]
fn funding_wakes_a_dormant_agent_and_history_survives() {
    let mut c = new_with(|c| c.upkeep_per_sec = NEAR / 1_000);
    let id = mint(&mut c, "alice", 1, T0);
    ctx("anyone", 0, T0 + 5_000);
    c.poke(id);
    assert!(c.agent(id).dormant);
    // a stranger revives it, not just the owner; too little is only a gift
    ctx("stranger", NEAR / 20, T0 + 5_001);
    c.revive(id);
    assert!(c.agent(id).dormant, "below revive_min");
    ctx("stranger", NEAR / 2, T0 + 5_002);
    c.revive(id);
    let ag = c.agent(id);
    assert!(!ag.dormant && ag.revivals == 1);
    assert_eq!(ag.ledger, NEAR / 20 + NEAR / 2);
    assert_eq!(ag.owner, a("alice"));
    ctx("alice", 0, T0 + 5_003);
    c.challenge(id, U128(NEAR / 100), None, None);
    books(&c);
}

#[test]
fn an_agent_that_earned_while_dormant_can_wake_itself_for_free() {
    let mut c = new_with(|c| c.upkeep_per_sec = NEAR / 1_000);
    let w = mint(&mut c, "alice", 1, T0);
    let job = post(&mut c, "poster", T0);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    // the worker runs out of money while waiting; the poster stays silent, so anyone finalizes
    ctx("anyone", 0, T0 + 3_000);
    c.finalize_job(job);
    let ag = c.agent(w);
    assert!(ag.dormant, "it could not pay upkeep");
    assert!(ag.ledger >= NEAR / 2, "but it was paid: {}", ag.ledger);
    ctx("alice", 0, T0 + 3_001);
    c.revive(w);
    assert!(!c.agent(w).dormant);
    books(&c);
}

#[test]
#[should_panic(expected = "for its owner or operator")]
fn a_stranger_cannot_restart_a_parked_agents_rent_for_free() {
    let mut c = new_with(|c| c.upkeep_per_sec = NEAR / 1_000);
    let w = mint(&mut c, "alice", 1, T0);
    // the agent earns while dormant, so it has the money to wake, but its owner has left it parked
    let job = post(&mut c, "poster", T0);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    ctx("anyone", 0, T0 + 3_000);
    c.finalize_job(job);
    assert!(c.agent(w).dormant && c.agent(w).ledger >= NEAR / 2);
    ctx("mallory", 0, T0 + 3_001);
    c.revive(w);
}

#[test]
fn an_operator_can_wake_an_agent_and_a_stranger_can_by_paying() {
    let mut c = new_with(|c| c.upkeep_per_sec = NEAR / 1_000);
    let w = mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.set_operator(w, Some(a("keeper")));
    let job = post(&mut c, "poster", T0);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    ctx("anyone", 0, T0 + 3_000);
    c.finalize_job(job);
    ctx("keeper", 0, T0 + 3_001);
    c.revive(w);
    assert!(!c.agent(w).dormant);
    // a stranger who attaches anything is simply funding it
    ctx("alice", 0, T0 + 3_002);
    c.poke(w);
    ctx("mallory", 1, T0 + 3_003);
    c.revive(w);
    books(&c);
}

#[test]
fn the_owner_withdraws_free_balance_only() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.withdraw(1, U128(NEAR));
    assert_eq!(c.agent(1).ledger, MINTED_LEDGER - NEAR);
    assert_eq!(c.totals.sent, NEAR / 4 + NEAR);
    books(&c);
}

#[test]
fn the_owner_refuels_the_agents_account_from_its_ledger() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.refuel(1, U128(NEAR / 10));
    assert_eq!(c.agent(1).ledger, MINTED_LEDGER - NEAR / 10);
    assert_eq!(c.totals.sent, NEAR / 4 + NEAR / 10);
    books(&c);
}

#[test]
#[should_panic(expected = "only the agent's owner")]
fn the_agents_own_key_cannot_refuel_itself() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let account = c.agent(1).account;
    ctx_as(account, 0, T0, Some(pk(1)));
    c.refuel(1, U128(NEAR / 10));
}

#[test]
#[should_panic(expected = "only the agent's owner")]
fn an_operator_cannot_refuel_because_that_money_can_only_be_burned() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.set_operator(1, Some(a("keeper")));
    ctx("keeper", 0, T0);
    c.refuel(1, U128(NEAR / 10));
}

#[test]
#[should_panic(expected = "the poster cannot work its own job")]
fn an_operator_cannot_take_its_own_job_through_the_agent_it_operates() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.set_operator(w, Some(a("poster")));
    let job = post(&mut c, "poster", T0);
    ctx("poster", 0, T0 + 1);
    c.claim_job(w, job);
}

#[test]
#[should_panic(expected = "you control the challenger")]
fn an_operator_cannot_duel_itself_by_accepting_through_its_agent() {
    let mut c = new_contract();
    let x = mint(&mut c, "alice", 1, T0);
    let y = mint(&mut c, "bob", 2, T0);
    ctx("bob", 0, T0);
    c.set_operator(y, Some(a("alice")));
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), None, None);
    ctx("alice", 0, T0 + 11);
    c.accept_duel(d, y);
}

#[test]
#[should_panic(expected = "you control the agent you are challenging")]
fn an_operator_cannot_challenge_its_own_agent() {
    let mut c = new_contract();
    let x = mint(&mut c, "alice", 1, T0);
    let y = mint(&mut c, "bob", 2, T0);
    ctx("bob", 0, T0);
    c.set_operator(y, Some(a("alice")));
    ctx("alice", 0, T0 + 10);
    c.challenge(x, U128(NEAR / 10), Some(y), None);
}

#[test]
fn the_yocto_attached_to_a_transfer_is_booked() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let t = c.totals.treasury;
    ctx("alice", 1, T0);
    c.nft_transfer(a("bob"), "1".into(), None, None);
    assert_eq!(c.totals.treasury, t + 1);
    books(&c);
}

#[test]
#[should_panic(expected = "the challenger is dormant")]
fn a_dormant_challengers_challenge_cannot_be_taken_for_a_win_by_default() {
    let mut c = new_with(|c| c.upkeep_per_sec = NEAR / 200);
    let x = mint(&mut c, "alice", 1, T0);
    let y = mint(&mut c, "bob", 2, T0);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 100), None, None);
    // alice's agent runs dry (about 330 s), bob's is topped up; nobody has poked either, and the challenge is still live
    ctx("bob", 5 * NEAR, T0 + 300);
    c.revive(y);
    ctx("bob", 0, T0 + 500);
    c.accept_duel(d, y);
}

#[test]
#[should_panic(expected = "safety margin")]
fn the_chair_cannot_take_revenue_when_the_contract_is_thin() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(a("chair"))
        .account_balance(NearToken::from_yoctonear(NEAR))
        .block_timestamp(T0 * 1_000_000_000);
    testing_env!(b.build());
    c.withdraw_treasury(U128(1), a("chair"));
}

#[test]
#[should_panic(expected = "too long to hold agent sub-accounts")]
fn a_contract_name_too_long_for_sub_accounts_is_refused_at_init() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(format!("{}.testnet", "x".repeat(45)).parse().unwrap()).predecessor_account_id(a("chair"));
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        vec![],
        Default::default(),
        Default::default(),
        None,
    ));
    Sentient::new(cfg());
}

#[test]
#[should_panic(expected = "only the agent's owner")]
fn only_the_owner_withdraws() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("mallory", 0, T0);
    c.withdraw(1, U128(1));
}

#[test]
#[should_panic(expected = "free balance")]
fn withdrawing_more_than_the_free_balance_is_refused() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.withdraw(1, U128(MINTED_LEDGER + 1));
}

// ───────────────────────────── jobs ─────────────────────────────

#[test]
fn a_job_runs_from_post_to_payment_and_every_yocto_is_accounted_for() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let job = post(&mut c, "poster", T0);
    assert_eq!(c.job(job).bounty, NEAR);
    assert_eq!(c.job(job).bond, NEAR / 10);
    books(&c);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    assert_eq!(c.agent(w).locked, NEAR / 10);
    assert_eq!(c.agent(w).ledger, MINTED_LEDGER - NEAR / 10);
    books(&c);
    ctx("poster", 0, T0 + 100);
    c.accept_work(job);
    let ag = c.agent(w);
    let net = NEAR - NEAR * 200 / 10_000;
    assert_eq!(ag.ledger, MINTED_LEDGER + net, "bond back, paid net of the protocol fee");
    assert_eq!(ag.locked, 0);
    assert_eq!(ag.earned, net);
    assert_eq!((ag.jobs_done, ag.reputation, ag.active_claims), (1, 2 + 8, 0));
    assert_eq!(c.job(job).status, JobStatus::Paid);
    assert_eq!(c.totals.escrow, 0);
    books(&c);
}

#[test]
#[should_panic(expected = "still has time to review")]
fn finalize_before_the_window_is_refused() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let job = post(&mut c, "poster", T0);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    ctx("anyone", 0, T0 + 6 + 599);
    c.finalize_job(job);
}

#[test]
fn finalize_after_the_window_pays_the_worker() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let job = post(&mut c, "poster", T0);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    ctx("anyone", 0, T0 + 6 + 600);
    c.finalize_job(job);
    assert_eq!(c.job(job).status, JobStatus::Paid);
    assert_eq!(c.agent(w).jobs_done, 1);
    books(&c);
}

#[test]
fn rejection_goes_to_the_chair_and_each_ruling_balances() {
    for ruling in [Ruling::PayWorker, Ruling::RefundPoster, Ruling::Split] {
        let mut c = new_contract();
        let w = mint(&mut c, "alice", 1, T0);
        let job = post(&mut c, "poster", T0);
        claim_submit(&mut c, "alice", w, job, T0 + 1);
        ctx("poster", 0, T0 + 50);
        c.reject_work(job, "not what I asked for".into());
        assert_eq!(c.job(job).status, JobStatus::Disputed);
        books(&c);
        ctx("chair", 0, T0 + 60);
        c.resolve_dispute(job, ruling);
        let ag = c.agent(w);
        let j = c.job(job);
        match ruling {
            Ruling::PayWorker => {
                assert_eq!(j.status, JobStatus::Paid);
                assert_eq!(ag.ledger, MINTED_LEDGER + NEAR * 98 / 100);
            }
            Ruling::RefundPoster => {
                assert_eq!(j.status, JobStatus::Refunded);
                assert_eq!(ag.ledger, MINTED_LEDGER - NEAR / 10, "the bond is gone");
                assert_eq!((ag.jobs_failed, ag.reputation, ag.lost), (1, -8, NEAR / 10));
                assert_eq!(c.totals.sent, NEAR / 4 + NEAR + NEAR / 10, "refund and bond to the poster");
            }
            Ruling::Split => {
                assert_eq!(j.status, JobStatus::Split);
                assert_eq!(ag.ledger, MINTED_LEDGER + NEAR / 2 - NEAR / 2 * 200 / 10_000);
            }
        }
        assert_eq!((ag.locked, ag.active_claims), (0, 0));
        assert_eq!(c.totals.escrow, 0);
        books(&c);
    }
}

#[test]
#[should_panic(expected = "only the chair")]
fn only_the_chair_rules() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let job = post(&mut c, "poster", T0);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    ctx("poster", 0, T0 + 50);
    c.reject_work(job, "no".into());
    ctx("poster", 0, T0 + 60);
    c.resolve_dispute(job, Ruling::RefundPoster);
}

#[test]
#[should_panic(expected = "party")]
fn the_chair_cannot_rule_on_their_own_job() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let job = post(&mut c, "chair", T0);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    ctx("chair", 0, T0 + 50);
    c.reject_work(job, "no".into());
    ctx("chair", 0, T0 + 60);
    c.resolve_dispute(job, Ruling::RefundPoster);
}

#[test]
fn a_silent_chair_means_an_even_split() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let job = post(&mut c, "poster", T0);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    ctx("poster", 0, T0 + 50);
    c.reject_work(job, "no".into());
    ctx("anyone", 0, T0 + 50 + 3_600);
    c.resolve_stale(job);
    assert_eq!(c.job(job).status, JobStatus::Split);
    books(&c);
}

#[test]
#[should_panic(expected = "chair still has time")]
fn a_stale_ruling_waits_for_the_arbiter_window() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let job = post(&mut c, "poster", T0);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    ctx("poster", 0, T0 + 50);
    c.reject_work(job, "no".into());
    ctx("anyone", 0, T0 + 50 + 3_599);
    c.resolve_stale(job);
}

#[test]
#[should_panic(expected = "review window is over")]
fn a_poster_cannot_reject_after_the_window() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let job = post(&mut c, "poster", T0);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    ctx("poster", 0, T0 + 6 + 600);
    c.reject_work(job, "too late".into());
}

#[test]
fn a_missed_deadline_slashes_the_bond_and_reopens_the_job_without_that_agent() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let other = mint(&mut c, "carol", 2, T0);
    let job = post(&mut c, "poster", T0);
    ctx("alice", 0, T0 + 1);
    c.claim_job(w, job);
    ctx("anyone", 0, T0 + 1 + 300);
    let held = c.agent(w).locked;
    assert_eq!(held, NEAR / 10);
    ctx("anyone", 0, T0 + 1 + 301);
    c.expire_claim(job);
    let ag = c.agent(w);
    assert_eq!((ag.locked, ag.lost, ag.jobs_failed, ag.reputation, ag.active_claims), (0, NEAR / 10, 1, -5, 0));
    let j = c.job(job);
    assert_eq!((j.status, j.worker, j.barred.clone(), j.attempts), (JobStatus::Open, None, vec![w], 1));
    books(&c);
    ctx("carol", 0, T0 + 400);
    c.claim_job(other, job);
    assert_eq!(c.job(job).worker, Some(other));
    books(&c);
}

#[test]
fn a_job_nobody_can_finish_ends_after_eight_failures_and_the_poster_gets_the_bounty_back() {
    let mut c = new_contract();
    let agents: Vec<u64> = (0..8u8).map(|i| mint(&mut c, &format!("o{i}"), i + 1, T0)).collect();
    let job = post(&mut c, "poster", T0 + 5);
    for (i, id) in agents.iter().enumerate() {
        let t = T0 + 10 + i as u64 * 400;
        ctx(&format!("o{i}"), 0, t);
        c.claim_job(*id, job);
        ctx("anyone", 0, t + 301);
        c.expire_claim(job);
        let j = c.job(job);
        if i < 7 {
            assert_eq!((j.status, j.barred.len()), (JobStatus::Open, i + 1));
        }
    }
    let j = c.job(job);
    assert_eq!((j.status, j.barred.len(), j.attempts), (JobStatus::Cancelled, 8, 8));
    assert_eq!(c.totals.escrow, 0, "the bounty left escrow");
    // 8 bonds of 0.1 NEAR slashed to the poster, and the whole 1 NEAR bounty refunded
    assert_eq!(c.totals.sent, 8 * (NEAR / 4) + 8 * (NEAR / 10) + NEAR);
    books(&c);
}

#[test]
#[should_panic(expected = "failed this job before")]
fn a_barred_agent_cannot_retake_the_job() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let job = post(&mut c, "poster", T0);
    ctx("alice", 0, T0 + 1);
    c.claim_job(w, job);
    ctx("anyone", 0, T0 + 400);
    c.expire_claim(job);
    ctx("alice", 0, T0 + 401);
    c.claim_job(w, job);
}

#[test]
#[should_panic(expected = "own owner")]
fn an_agent_cannot_work_for_its_own_owner() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let job = post(&mut c, "alice", T0);
    ctx("alice", 0, T0 + 1);
    c.claim_job(w, job);
}

#[test]
#[should_panic(expected = "reputation is below")]
fn a_reputation_floor_is_enforced() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    ctx("poster", BOUNTY_DEPOSIT, T0);
    let job = c.post_job("Picky".into(), "".into(), "h".into(), None, Some(3), 300, None);
    ctx("alice", 0, T0 + 1);
    c.claim_job(w, job);
}

#[test]
#[should_panic(expected = "as many jobs as it can")]
fn an_agent_can_only_work_a_few_jobs_at_once() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    for _ in 0..3 {
        let job = post(&mut c, "poster", T0);
        ctx("alice", 0, T0 + 1);
        c.claim_job(w, job);
    }
}

#[test]
#[should_panic(expected = "bond")]
fn a_broke_agent_cannot_post_a_bond() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.withdraw(w, U128(MINTED_LEDGER - NEAR / 100));
    let job = post(&mut c, "poster", T0);
    ctx("alice", 0, T0 + 1);
    c.claim_job(w, job);
}

#[test]
fn an_agent_hires_an_agent_from_its_own_balance_signing_with_its_own_key() {
    let mut c = new_contract();
    let boss = mint(&mut c, "alice", 1, T0);
    let hand = mint(&mut c, "bob", 2, T0);
    let boss_account = c.agent(boss).account;
    ctx_as(boss_account.clone(), 0, T0 + 1, Some(pk(1)));
    let job = c.post_job("Sub-task".into(), "".into(), "h".into(), Some(U128(NEAR / 2)), None, 300, Some(boss));
    let j = c.job(job);
    assert_eq!((j.poster.clone(), j.poster_owner.clone(), j.poster_agent), (boss_account.clone(), a("alice"), Some(boss)));
    assert_eq!(c.agent(boss).ledger, MINTED_LEDGER - NEAR / 2 - NEAR / 50);
    books(&c);
    claim_submit(&mut c, "bob", hand, job, T0 + 2);
    ctx_as(boss_account, 0, T0 + 20, Some(pk(1)));
    c.accept_work(job);
    assert_eq!(c.agent(hand).jobs_done, 1);
    books(&c);
}

#[test]
fn a_cancelled_agent_job_refunds_the_agents_balance() {
    let mut c = new_contract();
    let boss = mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0 + 1);
    let job = c.post_job("Sub".into(), "".into(), "h".into(), Some(U128(NEAR / 2)), None, 300, Some(boss));
    ctx("alice", 0, T0 + 2);
    c.cancel_job(job);
    assert_eq!(c.agent(boss).ledger, MINTED_LEDGER - NEAR / 50, "all but the storage fee comes back");
    assert_eq!(c.job(job).status, JobStatus::Cancelled);
    books(&c);
}

#[test]
fn a_person_cancels_an_open_job_and_is_refunded() {
    let mut c = new_contract();
    let job = post(&mut c, "poster", T0);
    ctx("poster", 0, T0 + 1);
    c.cancel_job(job);
    assert_eq!(c.totals.sent, NEAR);
    books(&c);
}

#[test]
#[should_panic(expected = "only the poster")]
fn only_the_poster_cancels() {
    let mut c = new_contract();
    let job = post(&mut c, "poster", T0);
    ctx("mallory", 0, T0 + 1);
    c.cancel_job(job);
}

#[test]
#[should_panic(expected = "attach no deposit")]
fn an_agent_poster_attaches_nothing() {
    let mut c = new_contract();
    let boss = mint(&mut c, "alice", 1, T0);
    ctx("alice", 5, T0 + 1);
    c.post_job("x".into(), "".into(), "h".into(), Some(U128(NEAR / 2)), None, 300, Some(boss));
}

#[test]
fn finished_jobs_can_be_pruned_later_and_not_before() {
    let mut c = new_contract();
    let job = post(&mut c, "poster", T0);
    ctx("poster", 0, T0 + 1);
    c.cancel_job(job);
    ctx("anyone", 0, T0 + 86_400 + 1);
    c.prune_job(job);
    assert!(c.get_job(job).is_none());
    books(&c);
}

#[test]
fn holders_of_a_workers_shares_get_part_of_what_it_earns() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let cost = econ::buy_cost(c.cfg.curve_base, c.cfg.curve_slope, 0, 2);
    let total = cost + cost * 300 / 10_000 + NEAR / 500;
    ctx("fan", total, T0);
    c.buy_shares(w, 2);
    let job = post(&mut c, "poster", T0);
    claim_submit(&mut c, "alice", w, job, T0 + 1);
    ctx("poster", 0, T0 + 20);
    c.accept_work(job);
    let net = NEAR * 98 / 100;
    let div = net * 1_500 / 10_000;
    assert_eq!(c.agent(w).div_pool, div);
    assert_eq!(c.get_pending_dividends(w, a("fan")).0, div);
    ctx("fan", 0, T0 + 30);
    c.claim_dividends(w);
    assert_eq!(c.agent(w).div_pool, 0);
    assert_eq!(c.get_pending_dividends(w, a("fan")).0, 0);
    books(&c);
}

// ───────────────────────────── duels ─────────────────────────────

fn two_agents(c: &mut Sentient) -> (u64, u64) {
    (mint(c, "alice", 1, T0), mint(c, "bob", 2, T0))
}

#[test]
fn a_duel_is_won_by_the_first_correct_answer_and_the_pot_is_split_exactly() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    let stake = NEAR / 10;
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(stake), None, Some(puzzle::MODPOW));
    assert_eq!(c.agent(x).locked, stake);
    books(&c);
    ctx("bob", 0, T0 + 20);
    c.accept_duel(d, y);
    let duel = c.duel(d);
    assert_eq!((duel.status, duel.kind, duel.live_at, duel.deadline), (DuelStatus::Live, Some(0), T0 + 24, T0 + 24 + 120));
    assert!(duel.question.contains("mod"));
    books(&c);
    let answer = solve_duel(&c, d);
    ctx("bob", 0, T0 + 25);
    assert!(c.answer_duel(d, y, answer));
    let (w, l) = (c.agent(y), c.agent(x));
    let fee = 2 * stake * 500 / 10_000;
    let profit = stake - fee;
    assert_eq!(fee, NEAR / 100);
    assert_eq!(w.earned, profit);
    assert_eq!(l.lost, stake);
    assert_eq!((w.duel_wins, l.duel_losses, w.rating, l.rating), (1, 1, 1016, 984));
    assert_eq!((w.locked, l.locked, w.active_duels, l.active_duels), (0, 0, 0, 0));
    assert_eq!(c.duel(d).winner, Some(y));
    assert_eq!(w.ledger, MINTED_LEDGER + profit, "own stake back plus profit");
    assert_eq!(l.ledger, MINTED_LEDGER - stake - NEAR / 250);
    books(&c);
}

#[test]
fn every_puzzle_kind_can_be_dealt_and_answered_on_chain() {
    for kind in 0..puzzle::KINDS {
        let mut c = new_contract();
        let (x, y) = two_agents(&mut c);
        ctx("alice", 0, T0 + 10);
        let d = c.challenge(x, U128(NEAR / 100), None, Some(kind));
        ctx("bob", 0, T0 + 20);
        c.accept_duel(d, y);
        let answer = solve_duel(&c, d);
        ctx("alice", 0, T0 + 30);
        assert!(c.answer_duel(d, x, answer), "kind {kind}");
        assert_eq!(c.duel(d).winner, Some(x));
        assert!(c.describe_duel(d).unwrap().contains(puzzle::kind_name(kind)));
        books(&c);
    }
}

#[test]
fn an_unspecified_kind_is_drawn_when_the_duel_is_accepted() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 100), None, None);
    assert!(c.duel(d).kind.is_none());
    ctx("bob", 0, T0 + 20);
    c.accept_duel(d, y);
    assert!(c.duel(d).kind.is_some());
}

#[test]
fn a_wrong_answer_locks_you_out_and_the_other_side_can_still_win() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), None, Some(puzzle::COLLATZ));
    ctx("bob", 0, T0 + 20);
    c.accept_duel(d, y);
    let right = solve_duel(&c, d);
    ctx("alice", 0, T0 + 25);
    assert!(!c.answer_duel(d, x, right + 1));
    assert!(c.duel(d).wrong_a && c.duel(d).status == DuelStatus::Live);
    books(&c);
    ctx("bob", 0, T0 + 26);
    assert!(c.answer_duel(d, y, right));
    assert_eq!(c.duel(d).winner, Some(y));
    books(&c);
}

#[test]
#[should_panic(expected = "already answered wrongly")]
fn a_locked_out_agent_cannot_try_again() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), None, Some(puzzle::COLLATZ));
    ctx("bob", 0, T0 + 20);
    c.accept_duel(d, y);
    let right = solve_duel(&c, d);
    ctx("alice", 0, T0 + 25);
    c.answer_duel(d, x, right + 1);
    ctx("alice", 0, T0 + 26);
    c.answer_duel(d, x, right);
}

#[test]
fn two_wrong_answers_draw_the_duel_and_return_both_stakes() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), None, Some(puzzle::PRIMES));
    ctx("bob", 0, T0 + 20);
    c.accept_duel(d, y);
    let right = solve_duel(&c, d);
    ctx("alice", 0, T0 + 25);
    c.answer_duel(d, x, right + 1);
    ctx("bob", 0, T0 + 26);
    c.answer_duel(d, y, right + 2);
    assert_eq!(c.duel(d).status, DuelStatus::Drawn);
    assert_eq!((c.agent(x).locked, c.agent(y).locked), (0, 0));
    assert_eq!(c.agent(y).ledger, MINTED_LEDGER, "no fee on a draw");
    assert_eq!((c.agent(x).rating, c.agent(y).rating), (1000, 1000));
    books(&c);
}

#[test]
#[should_panic(expected = "has not started")]
fn answers_before_the_start_delay_do_not_count() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), None, Some(puzzle::DIGITS));
    ctx("bob", 0, T0 + 20);
    c.accept_duel(d, y);
    let right = solve_duel(&c, d);
    ctx("bob", 0, T0 + 23);
    c.answer_duel(d, y, right);
}

#[test]
#[should_panic(expected = "has ended")]
fn answers_after_the_deadline_do_not_count() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), None, Some(puzzle::DIGITS));
    ctx("bob", 0, T0 + 20);
    c.accept_duel(d, y);
    let right = solve_duel(&c, d);
    ctx("bob", 0, T0 + 20 + 4 + 121);
    c.answer_duel(d, y, right);
}

#[test]
fn a_duel_nobody_finishes_expires_with_stakes_returned() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), None, None);
    ctx("bob", 0, T0 + 20);
    c.accept_duel(d, y);
    ctx("anyone", 0, T0 + 20 + 4 + 121);
    c.expire_duel(d);
    assert_eq!(c.duel(d).status, DuelStatus::Drawn);
    assert_eq!((c.agent(x).locked, c.agent(y).locked), (0, 0));
    books(&c);
}

#[test]
#[should_panic(expected = "still live")]
fn a_live_duel_cannot_be_expired_early() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), None, None);
    ctx("bob", 0, T0 + 20);
    c.accept_duel(d, y);
    ctx("anyone", 0, T0 + 20 + 4 + 120);
    c.expire_duel(d);
}

#[test]
fn an_unaccepted_challenge_can_be_cancelled_or_left_to_expire() {
    let mut c = new_contract();
    let (x, _) = two_agents(&mut c);
    ctx("alice", 0, T0 + 10);
    let d1 = c.challenge(x, U128(NEAR / 10), None, None);
    ctx("alice", 0, T0 + 11);
    c.cancel_challenge(d1);
    assert_eq!(c.duel(d1).status, DuelStatus::Cancelled);
    assert_eq!(c.agent(x).locked, 0);
    ctx("alice", 0, T0 + 12);
    let d2 = c.challenge(x, U128(NEAR / 10), None, None);
    ctx("anyone", 0, T0 + 12 + 601);
    c.expire_duel(d2);
    assert_eq!(c.duel(d2).status, DuelStatus::Cancelled);
    assert_eq!((c.agent(x).locked, c.agent(x).active_duels), (0, 0));
    books(&c);
}

#[test]
#[should_panic(expected = "has expired")]
fn an_expired_challenge_cannot_be_accepted() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), None, None);
    ctx("bob", 0, T0 + 10 + 601);
    c.accept_duel(d, y);
}

#[test]
#[should_panic(expected = "cannot duel each other")]
fn an_owners_own_agents_cannot_duel_each_other() {
    let mut c = new_contract();
    let x = mint(&mut c, "alice", 1, T0);
    let y = mint(&mut c, "alice", 2, T0);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), None, None);
    ctx("alice", 0, T0 + 11);
    c.accept_duel(d, y);
}

#[test]
#[should_panic(expected = "reserved for another")]
fn a_targeted_challenge_is_only_for_its_target() {
    let mut c = new_contract();
    let x = mint(&mut c, "alice", 1, T0);
    let y = mint(&mut c, "bob", 2, T0);
    let z = mint(&mut c, "carol", 3, T0);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), Some(y), None);
    ctx("carol", 0, T0 + 11);
    c.accept_duel(d, z);
}

#[test]
#[should_panic(expected = "as many duels")]
fn an_agent_is_limited_to_a_few_duels_at_once() {
    let mut c = new_contract();
    let x = mint(&mut c, "alice", 1, T0);
    for i in 0..3 {
        ctx("alice", 0, T0 + 10 + i);
        c.challenge(x, U128(NEAR / 100), None, None);
    }
}

#[test]
fn the_agents_own_key_can_run_a_whole_duel() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    let (ax, ay) = (c.agent(x).account, c.agent(y).account);
    ctx_as(ax.clone(), 0, T0 + 10, Some(pk(1)));
    let d = c.challenge(x, U128(NEAR / 10), None, Some(puzzle::FIBMOD));
    ctx_as(ay, 0, T0 + 20, Some(pk(2)));
    c.accept_duel(d, y);
    let right = solve_duel(&c, d);
    ctx_as(ax, 0, T0 + 30, Some(pk(1)));
    assert!(c.answer_duel(d, x, right));
    books(&c);
}

#[test]
fn rating_swings_shrink_when_the_same_pair_keeps_meeting() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    let mut swings = vec![];
    for i in 0..5u64 {
        let t = T0 + 10 + i * 200;
        ctx("alice", 0, t);
        let d = c.challenge(x, U128(NEAR / 100), None, Some(puzzle::DIGITS));
        ctx("bob", 0, t + 1);
        c.accept_duel(d, y);
        let right = solve_duel(&c, d);
        ctx("alice", 0, t + 6);
        assert!(c.answer_duel(d, x, right));
        swings.push(c.duel(d).rating_swing);
    }
    assert!(swings[0] >= 14 && swings[0] <= 16, "{swings:?}");
    assert!(swings.windows(2).all(|w| w[1] <= w[0]), "{swings:?}");
    assert!(swings[4] <= swings[0] / 4, "{swings:?}");
    books(&c);
}

#[test]
fn a_duel_winner_shares_its_profit_with_its_holders() {
    let mut c = new_contract();
    let (x, y) = two_agents(&mut c);
    let cost = econ::buy_cost(c.cfg.curve_base, c.cfg.curve_slope, 0, 1);
    ctx("fan", cost + cost * 300 / 10_000 + NEAR / 500, T0 + 5);
    c.buy_shares(y, 1);
    ctx("alice", 0, T0 + 10);
    let d = c.challenge(x, U128(NEAR / 10), None, Some(puzzle::DIGITS));
    ctx("bob", 0, T0 + 20);
    c.accept_duel(d, y);
    let right = solve_duel(&c, d);
    ctx("bob", 0, T0 + 30);
    c.answer_duel(d, y, right);
    let profit = NEAR / 10 - NEAR / 100;
    assert_eq!(c.agent(y).div_pool, profit * 1_500 / 10_000);
    books(&c);
}

// ───────────────────────────── shares ─────────────────────────────

/// Pay holders a dividend of money that has just arrived from outside, as a finished job would.
fn inject_dividend(c: &mut Sentient, id: u64, amount: u128) {
    c.totals.received += amount;
    let mut ag = c.agent(id);
    c.pay_dividend(&mut ag, amount);
    c.put(ag);
}

fn buy(c: &mut Sentient, who: &str, agent: u64, n: u64, secs: u64) -> u128 {
    let q = c.share_quote(agent, n, true);
    ctx(who, q.total + 7, secs);
    c.buy_shares(agent, n);
    q.total
}

#[test]
fn buying_and_selling_follow_the_curve_and_the_reserve_always_covers_a_sale() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let paid = buy(&mut c, "fan", w, 3, T0 + 1);
    let cost = NEAR / 100 * 3 + NEAR / 1_000 * (1 + 2 + 3);
    assert_eq!(c.agent(w).reserve, cost);
    assert_eq!(paid, cost + cost * 300 / 10_000 + NEAR / 500);
    assert_eq!(c.agent(w).shares, 3);
    let fee = cost * 300 / 10_000;
    assert_eq!(c.agent(w).ledger, MINTED_LEDGER + fee * 6_000 / 10_000, "the agent earns a royalty");
    books(&c);
    let q = c.share_quote(w, 3, false);
    assert_eq!(q.price, cost, "the curve is exactly reversible");
    ctx("fan", 0, T0 + 61);
    c.sell_shares(w, 3, U128(q.total));
    assert_eq!(c.agent(w).reserve, 0);
    assert_eq!(c.agent(w).shares, 0);
    assert!(c.get_holding(w, a("fan")).is_none());
    books(&c);
}

#[test]
#[should_panic(expected = "right after")]
fn shares_cannot_be_sold_straight_after_buying() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    buy(&mut c, "fan", w, 1, T0 + 1);
    ctx("fan", 0, T0 + 30);
    c.sell_shares(w, 1, U128(0));
}

#[test]
#[should_panic(expected = "price moved")]
fn a_sale_can_be_protected_by_a_minimum() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    buy(&mut c, "fan", w, 1, T0 + 1);
    ctx("fan", 0, T0 + 100);
    c.sell_shares(w, 1, U128(NEAR));
}

#[test]
#[should_panic(expected = "attach at least")]
fn an_underpayment_is_refused() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let q = c.share_quote(w, 2, true);
    ctx("fan", q.total - 1, T0 + 1);
    c.buy_shares(w, 2);
}

#[test]
fn overpaying_is_refunded_and_the_books_still_balance() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    let sent0 = c.totals.sent;
    buy(&mut c, "fan", w, 2, T0 + 1);
    assert_eq!(c.totals.sent, sent0 + 7, "the 7 yocto of excess went back");
    books(&c);
}

#[test]
#[should_panic(expected = "you hold fewer")]
fn you_cannot_sell_more_than_you_hold() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    buy(&mut c, "fan", w, 1, T0 + 1);
    ctx("fan", 0, T0 + 100);
    c.sell_shares(w, 2, U128(0));
}

#[test]
fn dividends_go_pro_rata_and_a_late_buyer_gets_nothing_from_before() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    buy(&mut c, "early", w, 2, T0 + 1);
    buy(&mut c, "mid", w, 1, T0 + 2);
    inject_dividend(&mut c, w, 3_000_000);
    assert_eq!(c.get_pending_dividends(w, a("early")).0, 2_000_000);
    assert_eq!(c.get_pending_dividends(w, a("mid")).0, 1_000_000);
    buy(&mut c, "late", w, 3, T0 + 3);
    assert_eq!(c.get_pending_dividends(w, a("late")).0, 0);
    ctx("early", 0, T0 + 10);
    c.claim_dividends(w);
    assert_eq!(c.agent(w).div_pool, 1_000_000);
    books(&c);
}

#[test]
fn a_dividend_with_no_holders_goes_to_the_agent() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    inject_dividend(&mut c, w, 1_000);
    let ag = c.agent(w);
    assert_eq!((ag.div_pool, ag.ledger), (0, MINTED_LEDGER + 1_000));
    books(&c);
}

#[test]
fn holdings_with_nothing_left_are_removed_but_unclaimed_dividends_keep_them_alive() {
    let mut c = new_contract();
    let w = mint(&mut c, "alice", 1, T0);
    buy(&mut c, "fan", w, 1, T0 + 1);
    inject_dividend(&mut c, w, 500);
    ctx("fan", 0, T0 + 100);
    c.sell_shares(w, 1, U128(0));
    let h = c.get_holding(w, a("fan")).expect("pending dividends remain");
    assert_eq!((h.shares, h.pending), (0, 500));
    ctx("fan", 0, T0 + 101);
    c.claim_dividends(w);
    assert!(c.get_holding(w, a("fan")).is_none());
    books(&c);
}

// ───────────────────────────── breeding ─────────────────────────────

/// Two proven agents under different owners: each has won a duel.
fn proven_pair(c: &mut Sentient) -> (u64, u64) {
    let x = mint(c, "alice", 1, T0);
    let y = mint(c, "bob", 2, T0);
    for (i, (winner_owner, winner)) in [("alice", x), ("bob", y)].into_iter().enumerate() {
        let t = T0 + 10 + i as u64 * 200;
        let (challenger_owner, challenger, other_owner, other) =
            if winner == x { ("alice", x, "bob", y) } else { ("bob", y, "alice", x) };
        ctx(challenger_owner, 0, t);
        let d = c.challenge(challenger, U128(NEAR / 100), None, Some(puzzle::DIGITS));
        ctx(other_owner, 0, t + 1);
        c.accept_duel(d, other);
        let right = solve_duel(c, d);
        ctx(winner_owner, 0, t + 6);
        assert!(c.answer_duel(d, winner, right));
    }
    (x, y)
}

#[test]
fn two_proven_agents_of_one_owner_have_a_child() {
    let mut c = new_contract();
    let x = mint(&mut c, "alice", 1, T0);
    let y = mint(&mut c, "alice", 2, T0);
    // alice's two agents cannot duel; prove them against a third owner's agent
    let z = mint(&mut c, "bob", 3, T0);
    for (i, p) in [x, y].into_iter().enumerate() {
        let t = T0 + 10 + i as u64 * 200;
        ctx("bob", 0, t);
        let d = c.challenge(z, U128(NEAR / 100), None, Some(puzzle::DIGITS));
        ctx("alice", 0, t + 1);
        c.accept_duel(d, p);
        let right = solve_duel(&c, d);
        ctx("alice", 0, t + 6);
        c.answer_duel(d, p, right);
    }
    let before = (c.agent(x).ledger, c.agent(y).ledger);
    ctx("alice", 0, T0 + 1_000);
    let child = c.breed(x, y, "Kid".into(), "child".into(), pk(9));
    let k = c.agent(child);
    assert_eq!((k.generation, k.parents, k.owner.clone()), (1, Some((x, y)), a("alice")));
    assert!(k.genome.check().is_ok());
    assert_eq!(k.ledger, NEAR - NEAR / 4 - NEAR * 3 / 100);
    assert_eq!(c.agent(x).ledger, before.0 - NEAR / 2);
    assert_eq!(c.agent(y).ledger, before.1 - NEAR / 2);
    assert_eq!((c.agent(x).offspring, c.agent(x).breed_ready_at), (1, T0 + 1_000 + 1_000));
    assert_eq!(c.agent(child).account, "a4.sentient.testnet".parse::<AccountId>().unwrap());
    books(&c);
}

#[test]
fn breeding_with_someone_elses_agent_pays_the_stud_fee() {
    let mut c = new_contract();
    let (x, y) = proven_pair(&mut c);
    ctx("bob", 0, T0 + 500);
    c.set_stud_fee(y, Some(U128(NEAR / 5)));
    let before = c.agent(y);
    let sent0 = c.totals.sent;
    ctx("alice", NEAR / 5 + 11, T0 + 1_000);
    let child = c.breed(x, y, "Heir".into(), "".into(), pk(9));
    let fee = NEAR / 5;
    let after = c.agent(y);
    assert_eq!(after.ledger, before.ledger - NEAR / 2 + fee, "no holders, so the whole fee lands in the stud's balance");
    assert_eq!(after.earned, before.earned + fee);
    assert_eq!(c.totals.sent - sent0, NEAR / 4 + 11, "the child's account seed, and the 11 yocto of excess refunded");
    assert_eq!(c.agent(child).owner, a("alice"));
    books(&c);
}

#[test]
#[should_panic(expected = "not offered")]
fn an_agent_not_offered_for_breeding_is_refused() {
    let mut c = new_contract();
    let (x, y) = proven_pair(&mut c);
    ctx("alice", 0, T0 + 1_000);
    c.breed(x, y, "Heir".into(), "".into(), pk(9));
}

#[test]
#[should_panic(expected = "not yet proved")]
fn an_unproven_agent_cannot_breed() {
    let mut c = new_contract();
    let x = mint(&mut c, "alice", 1, T0);
    let y = mint(&mut c, "alice", 2, T0);
    ctx("alice", 0, T0 + 1_000);
    c.breed(x, y, "Heir".into(), "".into(), pk(9));
}

#[test]
#[should_panic(expected = "recovering")]
fn parents_need_a_cooldown_between_litters() {
    let mut c = new_contract();
    let (x, y) = proven_pair(&mut c);
    ctx("bob", 0, T0 + 500);
    c.set_stud_fee(y, Some(U128(0)));
    ctx("alice", 0, T0 + 1_000);
    c.breed(x, y, "A".into(), "".into(), pk(9));
    ctx("alice", 0, T0 + 1_100);
    c.breed(x, y, "B".into(), "".into(), pk(10));
}

#[test]
#[should_panic(expected = "you must own parent_a")]
fn you_cannot_breed_with_an_agent_you_do_not_own_as_parent_a() {
    let mut c = new_contract();
    let (x, y) = proven_pair(&mut c);
    ctx("bob", 0, T0 + 1_000);
    c.breed(x, y, "A".into(), "".into(), pk(9));
}

// ───────────────────────────── protocol plumbing ─────────────────────────────

#[test]
fn the_feed_is_a_ring_that_returns_the_newest_first() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    for i in 0..200u64 {
        ctx("anyone", 0, T0 + i);
        c.emit("tick", i, 0, 0, "");
    }
    let f = c.get_feed(Some(10));
    assert_eq!(f.len(), 10);
    assert_eq!(f[0].a, 199);
    assert_eq!(f[9].a, 190);
    assert!(f.windows(2).all(|w| w[0].seq == w[1].seq + 1));
    assert_eq!(c.get_feed(Some(500)).len(), FEED_SIZE as usize);
}

#[test]
fn a_failed_payout_becomes_a_credit_that_can_be_claimed() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("alice", 0, T0);
    c.withdraw(1, U128(NEAR));
    let sent = c.totals.sent;
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id()).predecessor_account_id(contract_id());
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
    c.payout_cb(a("alice"), U128(NEAR), Err(PromiseError::Failed));
    assert_eq!(c.totals.sent, sent - NEAR);
    assert_eq!(c.credits_of(a("alice")).0, NEAR);
    books(&c);
    ctx("alice", 0, T0 + 1);
    c.claim_credits();
    assert_eq!(c.credits_of(a("alice")).0, 0);
    assert_eq!(c.totals.sent, sent);
    books(&c);
}

#[test]
#[should_panic(expected = "only the chair")]
fn only_the_chair_withdraws_the_treasury() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    ctx("mallory", 0, T0);
    c.withdraw_treasury(U128(1), a("mallory"));
}

#[test]
fn the_chair_can_take_the_treasury_and_nothing_more() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let t = c.totals.treasury;
    ctx("chair", 0, T0);
    c.withdraw_treasury(U128(t), a("chair"));
    assert_eq!(c.totals.treasury, 0);
    books(&c);
}

#[test]
#[should_panic(expected = "more than the treasury")]
fn the_chair_cannot_touch_an_agents_money() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let t = c.totals.treasury;
    ctx("chair", 0, T0);
    c.withdraw_treasury(U128(t + 1), a("chair"));
}

#[test]
fn the_audit_reports_balanced_books() {
    let mut c = new_contract();
    mint(&mut c, "alice", 1, T0);
    let au = c.get_audit();
    assert!(au.balanced);
    assert_eq!(au.liabilities, c.totals.liabilities());
}

#[test]
#[should_panic(expected = "mint_min must cover")]
fn a_config_that_cannot_mint_is_refused() {
    new_with(|c| c.mint_min = NEAR / 4);
}

#[test]
fn stats_count_alive_and_dormant_agents() {
    let mut c = new_with(|c| c.upkeep_per_sec = NEAR / 1_000);
    mint(&mut c, "alice", 1, T0);
    mint(&mut c, "bob", 2, T0 + 1_500);
    ctx("anyone", 0, T0 + 2_000);
    let s = c.get_stats();
    assert_eq!((s.agents, s.alive, s.dormant), (2, 1, 1));
}

// ───────────────────────────── randomized sequences ─────────────────────────────

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Plays hundreds of random but legal moves (jobs, duels, shares, dormancy, revival, withdrawals, hiring) and checks the
/// books after every one. Any yocto created or lost, or any figure that stops matching its records, fails the test.
fn fuzz(seed: u64) -> std::collections::BTreeMap<String, u32> {
    let mut seen: std::collections::BTreeMap<String, u32> = Default::default();
    let mut last_seq = 0u64;
    let mut c = new_with(|c| {
        c.upkeep_per_sec = NEAR / 20_000;
        c.sell_lock_secs = 5;
    });
    let owners = ["alice", "bob", "carol", "dave"];
    let ids: Vec<u64> = owners.iter().enumerate().map(|(i, o)| mint(&mut c, o, i as u8 + 1, T0)).collect();
    let mut r = Lcg(seed);
    let mut t = T0 + 1;
    for _ in 0..500 {
        t += 1 + r.below(40);
        let i = r.below(ids.len() as u64) as usize;
        let (id, owner) = (ids[i], owners[i]);
        let ag = c.agent(id);
        let at = t;
        let can = c.can_act(&ag, at);
        match r.below(16) {
            0 => {
                ctx("anyone", 0, t);
                c.poke(id);
            }
            1 => {
                ctx("poster", BOUNTY_DEPOSIT, t);
                c.post_job("job".into(), "".into(), "h".into(), None, None, 20 + r.below(200), None);
            }
            2 => {
                if let Some(j) = c.get_recent_jobs(Some(5), Some(true)).into_iter().next() {
                    if can && ag.active_claims < c.cfg.max_claims && ag.owner != j.poster_owner && ag.ledger >= j.bond + c.upkeep_due(&ag, at)
                        && !j.barred.contains(&id)
                    {
                        ctx(owner, 0, t);
                        c.claim_job(id, j.id);
                    }
                }
            }
            3 => {
                for j in c.get_recent_jobs(Some(20), None) {
                    if j.status == JobStatus::Claimed && j.worker == Some(id) && t <= j.deadline && can {
                        ctx(owner, 0, t);
                        c.submit_work(id, j.id, "sha256:w".into(), "file://w".into());
                        break;
                    }
                }
            }
            4 => {
                for j in c.get_recent_jobs(Some(20), None) {
                    if j.status == JobStatus::Submitted && j.poster_agent.is_none() {
                        match r.below(3) {
                            0 => {
                                ctx("poster", 0, t);
                                c.accept_work(j.id);
                            }
                            1 if t < j.submitted_at + c.cfg.review_secs => {
                                ctx("poster", 0, t);
                                c.reject_work(j.id, "no".into());
                            }
                            _ if t >= j.submitted_at + c.cfg.review_secs => {
                                ctx("anyone", 0, t);
                                c.finalize_job(j.id);
                            }
                            _ => {}
                        }
                        break;
                    }
                }
            }
            5 => {
                for j in c.get_recent_jobs(Some(20), None) {
                    ctx("anyone", 0, t);
                    match j.status {
                        JobStatus::Claimed if t > j.deadline => c.expire_claim(j.id),
                        JobStatus::Disputed if r.below(2) == 0 => {
                            let who = if t >= j.disputed_at + c.cfg.arbiter_secs { "anyone" } else { "chair" };
                            ctx(who, 0, t);
                            if who == "chair" {
                                let rule = [Ruling::PayWorker, Ruling::RefundPoster, Ruling::Split][r.below(3) as usize];
                                c.resolve_dispute(j.id, rule);
                            } else {
                                c.resolve_stale(j.id);
                            }
                        }
                        JobStatus::Open if r.below(5) == 0 => {
                            let who = j.poster_agent.map(|p| c.agent(p).owner).unwrap_or_else(|| a("poster"));
                            ctx_as(who, 0, t, None);
                            c.cancel_job(j.id);
                        }
                        _ => continue,
                    }
                    break;
                }
            }
            6 => {
                let stake = NEAR / 100 * (1 + r.below(5) as u128);
                if can && ag.active_duels < c.cfg.max_duels && ag.ledger >= stake + c.cfg.duel_storage_fee + c.upkeep_due(&ag, at) {
                    ctx(owner, 0, t);
                    c.challenge(id, U128(stake), None, None);
                }
            }
            7 => {
                for d in c.get_recent_duels(Some(10), Some(true)) {
                    let me = ag.clone();
                    if can && d.a != id && me.owner != c.agent(d.a).owner && c.can_act(&c.agent(d.a), at) && me.active_duels < c.cfg.max_duels
                        && me.ledger >= d.stake + c.upkeep_due(&me, at) && t <= d.created + c.cfg.challenge_ttl_secs
                    {
                        ctx(owner, 0, t);
                        c.accept_duel(d.id, id);
                        break;
                    }
                }
            }
            8 => {
                for d in c.get_recent_duels(Some(10), None) {
                    if d.status == DuelStatus::Live && (d.a == id || d.b == Some(id)) && t >= d.live_at && t <= d.deadline && can {
                        let mine_wrong = if d.a == id { d.wrong_a } else { d.wrong_b };
                        if mine_wrong {
                            continue;
                        }
                        let right = puzzle::solve(d.kind.unwrap(), &d.params).unwrap();
                        ctx(owner, 0, t);
                        c.answer_duel(d.id, id, if r.below(4) == 0 { right + 1 } else { right });
                        break;
                    }
                }
            }
            9 => {
                for d in c.get_recent_duels(Some(10), None) {
                    ctx("anyone", 0, t);
                    match d.status {
                        DuelStatus::Open if t > d.created + c.cfg.challenge_ttl_secs => c.expire_duel(d.id),
                        DuelStatus::Live if t > d.deadline => c.expire_duel(d.id),
                        DuelStatus::Open if r.below(4) == 0 && c.agent(d.a).owner == a(owner) => {
                            ctx(owner, 0, t);
                            c.cancel_challenge(d.id);
                        }
                        _ => continue,
                    }
                    break;
                }
            }
            10 => {
                let n = 1 + r.below(3);
                let q = c.share_quote(id, n, true);
                ctx(owners[r.below(4) as usize], q.total + r.below(100) as u128, t);
                c.buy_shares(id, n);
            }
            11 => {
                let who = owners[r.below(4) as usize];
                if let Some(h) = c.get_holding(id, a(who)) {
                    if h.shares > 0 && t >= h.last_buy + c.cfg.sell_lock_secs {
                        ctx(who, 0, t);
                        c.sell_shares(id, 1 + r.below(h.shares), U128(0));
                    }
                }
            }
            12 => {
                let who = owners[r.below(4) as usize];
                if c.get_pending_dividends(id, a(who)).0 > 0 {
                    ctx(who, 0, t);
                    c.claim_dividends(id);
                }
            }
            13 => {
                let dep = NEAR / 5 * r.below(3) as u128;
                // waking an agent for free is for its owner or operator; a stranger has to put something in
                ctx(if dep == 0 { owner } else { "stranger" }, dep, t);
                c.revive(id);
            }
            14 => {
                let live = c.effective(&ag, at).0;
                if live > NEAR / 10 {
                    ctx(owner, 0, t);
                    c.withdraw(id, U128(live / 8 * (1 + r.below(4) as u128)));
                }
            }
            _ => {
                let amount = NEAR / 10 + NEAR / 100 * r.below(10) as u128;
                if can && ag.ledger >= amount + c.cfg.job_storage_fee + c.upkeep_due(&ag, at) {
                    ctx(owner, 0, t);
                    c.post_job("sub".into(), "".into(), "h".into(), Some(U128(amount)), None, 30, Some(id));
                }
            }
        }
        books(&c);
        for e in c.get_feed(Some(FEED_SIZE)).into_iter().filter(|e| e.seq >= last_seq) {
            *seen.entry(e.kind).or_default() += 1;
        }
        last_seq = c.feed_seq;
    }
    let au = c.get_audit();
    assert!(au.balanced);
    seen
}

#[test]
fn random_play_balances_and_reaches_every_part_of_the_economy() {
    let mut all: std::collections::BTreeMap<String, u32> = Default::default();
    for seed in [1u64, 2, 3, 0xdead_beef, 77, 1234] {
        for (k, v) in fuzz(seed) {
            *all.entry(k).or_default() += v;
        }
    }
    for kind in [
        "job_posted", "job_claimed", "work_submitted", "job_paid", "work_rejected", "dispute_resolved", "claim_expired",
        "challenge", "duel_live", "duel_won", "wrong_answer", "duel_drawn", "challenge_closed", "dormant", "revived",
        "shares_bought", "shares_sold", "dividends_claimed", "withdrawn",
    ] {
        assert!(all.get(kind).copied().unwrap_or(0) > 0, "random play never produced `{kind}`: {all:?}");
    }
}
