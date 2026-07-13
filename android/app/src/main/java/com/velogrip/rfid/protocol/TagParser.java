package com.velogrip.rfid.protocol;

import com.velogrip.rfid.TagRead;

import java.util.List;

/**
 * Incremental parser: feed() receives raw bytes from the reader socket as they
 * arrive and returns any complete tag reads decoded from the stream so far.
 * Implementations keep internal buffer state between calls.
 */
public interface TagParser {
    List<TagRead> feed(byte[] data, int length);
}
