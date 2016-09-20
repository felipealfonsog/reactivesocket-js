'use strict';

var SlidingMedian = require('../common/slidingMedian');

var STARTUP_PENALTY = Math.floor(Number.MAX_SAFE_INTEGER / 2);
var INACTIVITY_PERIOD = 30 * 1000;

var CLOCK = {
    now: function () {
        var t = process.hrtime();
        return 1e9 * t[0] + t[1];
    }
};

function WeightedSocket(reactivesocket) {
    var self = this;
    this._underlying = reactivesocket;
    this._outstandings = 0;       // instantaneous rate
    this._stamp = CLOCK.now();     // last timestamp we sent a request
    this._stamp0 = self._stamp;   // last ts we sent a req. or receive a resp.
    this._duration = 0;           // instantaneous cumulative duration
    this._median = new SlidingMedian();
}

module.exports = WeightedSocket;

WeightedSocket.prototype.request = function request(req) {
    var self = this;
    var stream = self._underlying.request(req);
    var start = self._incr();
    stream.on('response', function _onResponse() {
        var now = CLOCK.now();
        var elapsed = now - start;
        self._observe(elapsed);
    });
    stream.on('terminate', function onRequestTerminate() {
        self._decr(start);
    });
    return stream;
};

WeightedSocket.prototype.availability = function availability() {
    var self = this;
    return self._underlying.availability();
};

WeightedSocket.prototype.close = function close(cb) {
    var self = this;
    self._underlying.close(cb);
};

WeightedSocket.prototype.getPredictedLatency = function getPredictedLatency() {
    var self = this;

    var now = CLOCK.now();
    var elapsed = now - self._stamp;

    var weight;
    var prediction = self._median.estimate();

    if (prediction === 0) {
        if (self._outstandings === 0) {
            weight = 0; // first request
        } else {
            // subsequent requests while we don't have any history
            weight = STARTUP_PENALTY + self._outstandings;
        }
    } else if (self._outstandings === 0 && elapsed > INACTIVITY_PERIOD) {
        // if we did't see any data for a while, we decay the prediction by
        // inserting artificial low value into the median
        self._median.insert(self._median.estimate() / 2);
        weight = self._median.estimate();
    } else {
        var predicted = prediction * self._outstandings;
        var instant = self._instantaneous(now);

        if (predicted < instant) { // NB: (0.0 < 0.0) == false
            // NB: _outstandings never equal 0 here
            weight = instant / self._outstandings;
        } else {
            // we are under the predictions
            weight = prediction;
        }
    }

    return weight;
};

WeightedSocket.prototype.getPending = function getPending() {
    var self = this;
    return self._outstandings;
};

/// Privates

WeightedSocket.prototype._instantaneous = function _instantaneous(now) {
    var self = this;
    return self._duration + (now - self._stamp0) * self._outstandings;
};

WeightedSocket.prototype._incr = function _incr() {
    var self = this;
    var now = CLOCK.now();
    self._duration += (now - self._stamp0) * self._outstandings;
    self._outstandings += 1;
    self._stamp = now;
    self._stamp0 = now;
    console.log('WeightedSocket ' + self.name + ' incr() ');
    return now;
};

// ts is the timestamp of when we sent the request
// (that we receive a response to)
WeightedSocket.prototype._decr = function _decr(ts) {
    var self = this;
    var now = CLOCK.now();
    self._duration += (now - self._stamp0) * self._outstandings;
    self._duration -= (now - ts);
    self._outstandings -= 1;
    self._stamp0 = now;
    console.log('WeightedSocket ' + self.name + ' decr() ');
    return now;
};

WeightedSocket.prototype._observe = function _observe(rtt) {
    var self = this;
    console.log('WeightedSocket ' + self.name + ' observe ' + rtt);
    self._median.insert(rtt);
};