# JAX-based GPU-parallel 6502 emulator for 6502life

from .chacha20 import (  # noqa: F401
    chacha20_block,
    chacha20_stream,
    derive_nonce,
    generate_board_init,
    seed_to_key,
)
from .oracle import (  # noqa: F401
    ReplicatorOracle,
    create_train_state,
    train_step,
    predict_batch,
    attention_blame,
    gradient_blame,
    pad_sequences,
    prepare_dataset,
)
from .hmm import (  # noqa: F401
    HMMParams,
    default_params as hmm_default_params,
    hmm_log_prob,
    hmm_log_prob_marginal,
    hmm_log_prob_sequential,
    hmm_score_batch,
    hmm_sample,
    discriminative_loss,
    count_params as hmm_count_params,
)
