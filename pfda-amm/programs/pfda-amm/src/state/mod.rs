pub mod batch_queue;
pub mod cleared_batch_history;
pub mod pool_state;
pub mod user_order_ticket;

pub use batch_queue::BatchQueue;
pub use cleared_batch_history::ClearedBatchHistory;
pub use pool_state::PoolState;
pub use user_order_ticket::UserOrderTicket;

/// Safely cast a mutable byte slice to a typed struct reference.
/// Requires the slice to be exactly `size_of::<T>()` bytes.
///
/// # Safety
/// The caller must ensure the byte slice comes from an account data buffer
/// that is properly aligned and has the correct length.
pub unsafe fn load_mut<T: Copy>(data: &mut [u8]) -> Option<&mut T> {
    if data.len() < core::mem::size_of::<T>() {
        return None;
    }
    let ptr = data.as_mut_ptr() as *mut T;
    Some(&mut *ptr)
}

/// Safely cast a byte slice to a typed struct reference (immutable).
pub unsafe fn load<T: Copy>(data: &[u8]) -> Option<&T> {
    if data.len() < core::mem::size_of::<T>() {
        return None;
    }
    let ptr = data.as_ptr() as *const T;
    Some(&*ptr)
}
