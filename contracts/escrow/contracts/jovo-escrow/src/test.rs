#![cfg(test)]
extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env,
};

fn setup(
    env: &Env,
) -> (
    JovoEscrowClient<'_>,
    TokenClient<'_>,
    Address,
    SigningKey,
    BytesN<32>,
) {
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &sac.address());
    let sender = Address::generate(env);
    StellarAssetClient::new(env, &sac.address()).mint(&sender, &1_000);
    let contract_id = env.register(JovoEscrow, ());
    let client = JovoEscrowClient::new(env, &contract_id);
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let link_id = BytesN::from_array(env, &key.verifying_key().to_bytes());
    client.create(&sender, &token.address, &500, &link_id, &2_000);
    (client, token, sender, key, link_id)
}

fn sign(
    env: &Env,
    client: &JovoEscrowClient,
    key: &SigningKey,
    link_id: &BytesN<32>,
    to: &Address,
) -> BytesN<64> {
    let message = client.claim_message(link_id, to);
    let mut buffer = std::vec![0u8; message.len() as usize];
    message.copy_into_slice(&mut buffer);
    BytesN::from_array(env, &key.sign(&buffer).to_bytes())
}

#[test]
fn create_then_claim_pays_recipient() {
    let env = Env::default();
    let (client, token, sender, key, link_id) = setup(&env);
    assert_eq!(token.balance(&sender), 500);
    let recipient = Address::generate(&env);
    let signature = sign(&env, &client, &key, &link_id, &recipient);
    client.claim(&link_id, &recipient, &signature);
    assert_eq!(token.balance(&recipient), 500);
    assert!(client.get(&link_id).is_none());
}

#[test]
#[should_panic]
fn claim_signed_for_another_recipient_fails() {
    let env = Env::default();
    let (client, _token, _sender, key, link_id) = setup(&env);
    let (signed_for, actual_recipient) = (Address::generate(&env), Address::generate(&env));
    let signature = sign(&env, &client, &key, &link_id, &signed_for);
    client.claim(&link_id, &actual_recipient, &signature);
}

#[test]
fn cannot_claim_twice() {
    let env = Env::default();
    let (client, _token, _sender, key, link_id) = setup(&env);
    let recipient = Address::generate(&env);
    let signature = sign(&env, &client, &key, &link_id, &recipient);
    client.claim(&link_id, &recipient, &signature);
    assert!(client
        .try_claim(&link_id, &recipient, &signature)
        .is_err());
}

#[test]
fn refund_only_after_expiry() {
    let env = Env::default();
    let (client, token, sender, _key, link_id) = setup(&env);
    assert_eq!(client.try_refund(&link_id), Err(Ok(Error::NotExpired)));
    env.ledger().set_timestamp(2_001);
    client.refund(&link_id);
    assert_eq!(token.balance(&sender), 1_000);
}
