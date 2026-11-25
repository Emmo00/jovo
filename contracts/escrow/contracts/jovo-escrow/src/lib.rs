#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, xdr::ToXdr, Address, Bytes,
    BytesN, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    InvalidExpiry = 2,
    LinkExists = 3,
    LinkNotFound = 4,
    NotExpired = 5,
}

#[contracttype]
#[derive(Clone)]
pub struct Link {
    pub sender: Address,
    pub token: Address,
    pub amount: i128,
    pub expires_at: u64,
}

#[contracttype]
enum DataKey {
    Link(BytesN<32>),
}

fn build_message(env: &Env, link_id: &BytesN<32>, to: &Address) -> Bytes {
    let mut message = Bytes::from_slice(env, b"jovo-claim-v1");
    message.append(&Bytes::from_array(env, &link_id.to_array()));
    message.append(&env.current_contract_address().to_xdr(env));
    message.append(&to.clone().to_xdr(env));
    message
}

fn bump(env: &Env, key: &DataKey) {
    let max_ttl = env.storage().max_ttl();
    env.storage().persistent().extend_ttl(key, max_ttl, max_ttl);
}

#[contract]
pub struct JovoEscrow;

#[contractimpl]
impl JovoEscrow {
    pub fn create(
        env: Env,
        sender: Address,
        token: Address,
        amount: i128,
        link_id: BytesN<32>,
        expires_at: u64,
    ) -> Result<(), Error> {
        sender.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if expires_at <= env.ledger().timestamp() {
            return Err(Error::InvalidExpiry);
        }
        let key = DataKey::Link(link_id);
        if env.storage().persistent().has(&key) {
            return Err(Error::LinkExists);
        }
        token::Client::new(&env, &token).transfer(
            &sender,
            &env.current_contract_address(),
            &amount,
        );
        env.storage().persistent().set(
            &key,
            &Link {
                sender,
                token,
                amount,
                expires_at,
            },
        );
        bump(&env, &key);
        Ok(())
    }

    pub fn claim(
        env: Env,
        link_id: BytesN<32>,
        to: Address,
        signature: BytesN<64>,
    ) -> Result<(), Error> {
        let key = DataKey::Link(link_id.clone());
        let link: Link = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::LinkNotFound)?;
        let message = build_message(&env, &link_id, &to);
        env.crypto().ed25519_verify(&link_id, &message, &signature);
        env.storage().persistent().remove(&key);
        token::Client::new(&env, &link.token).transfer(
            &env.current_contract_address(),
            &to,
            &link.amount,
        );
        Ok(())
    }

    pub fn refund(env: Env, link_id: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Link(link_id);
        let link: Link = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::LinkNotFound)?;
        link.sender.require_auth();
        if env.ledger().timestamp() < link.expires_at {
            return Err(Error::NotExpired);
        }
        env.storage().persistent().remove(&key);
        token::Client::new(&env, &link.token).transfer(
            &env.current_contract_address(),
            &link.sender,
            &link.amount,
        );
        Ok(())
    }

    pub fn get(env: Env, link_id: BytesN<32>) -> Option<Link> {
        env.storage().persistent().get(&DataKey::Link(link_id))
    }

    pub fn bump(env: Env, link_id: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Link(link_id);
        if !env.storage().persistent().has(&key) {
            return Err(Error::LinkNotFound);
        }
        bump(&env, &key);
        Ok(())
    }

    pub fn claim_message(env: Env, link_id: BytesN<32>, to: Address) -> Bytes {
        build_message(&env, &link_id, &to)
    }
}

#[cfg(test)]
mod test;
