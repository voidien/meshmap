//! Minimal complex arithmetic (just what ITM needs), so the crate has no dependencies.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Complex {
    pub re: f64,
    pub im: f64,
}

impl Complex {
    pub const fn new(re: f64, im: f64) -> Self {
        Self { re, im }
    }

    pub fn abs(self) -> f64 {
        self.re.hypot(self.im)
    }

    /// Principal square root.
    pub fn sqrt(self) -> Self {
        let r = self.abs();
        let re = ((r + self.re) / 2.0).sqrt();
        let im = ((r - self.re) / 2.0).sqrt();
        Self { re, im: if self.im < 0.0 { -im } else { im } }
    }

    pub fn scale(self, k: f64) -> Self {
        Self { re: self.re * k, im: self.im * k }
    }

    pub fn add(self, o: Self) -> Self {
        Self { re: self.re + o.re, im: self.im + o.im }
    }

    pub fn sub(self, o: Self) -> Self {
        Self { re: self.re - o.re, im: self.im - o.im }
    }

    pub fn div(self, o: Self) -> Self {
        // Smith's algorithm: stable for wide-ranging magnitudes
        if o.re.abs() >= o.im.abs() {
            let r = o.im / o.re;
            let d = o.re + o.im * r;
            Self { re: (self.re + self.im * r) / d, im: (self.im - self.re * r) / d }
        } else {
            let r = o.re / o.im;
            let d = o.re * r + o.im;
            Self { re: (self.re * r + self.im) / d, im: (self.im * r - self.re) / d }
        }
    }
}
